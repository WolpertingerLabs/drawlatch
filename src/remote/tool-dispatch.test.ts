/**
 * Tests for executeProxyRequest's OAuth2 wiring (Card 3, request path).
 *
 * Covers: managed Bearer injection + Authorization precedence over a template
 * header; 401 → forceRefresh → single retry success; persistent 401 → returns
 * 401 with NO loop (asserted via fetch + getAccessToken call counts);
 * OAuth2InvalidGrantError surfaced as a re-auth error (no token material);
 * and a non-oauth2 regression confirming the plain path is unchanged.
 *
 * The TokenManager is faked (its internals are covered by token-manager.test.ts);
 * here we only verify the request path drives it correctly. The outbound API
 * fetch is mocked via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeProxyRequest } from './tool-dispatch.js';
import {
  OAuth2InvalidGrantError,
  OAuth2RefreshError,
  type TokenManager,
} from './oauth/token-manager.js';
import type { ResolvedRoute } from '../shared/config.js';
import type { OAuth2Config } from '../shared/config.js';

// ── Fixtures (test-scope only — NOT a src/connections template) ──────────────

const FIXTURE_OAUTH2: OAuth2Config = {
  tokenUrl: 'https://accounts.fixture.com/token',
  grant: 'refresh_token',
  clientAuth: 'basic',
  secretRefs: { clientId: 'FX_ID', clientSecret: 'FX_SECRET', refreshToken: 'FX_RT' },
};

function oauthRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    alias: 'fixture',
    headers: {},
    secrets: { FX_ID: 'id-val', FX_SECRET: 'secret-val', FX_RT: 'rt-val' },
    allowedEndpoints: ['https://api.fixture.com/**'],
    resolveSecretsInBody: false,
    oauth2: FIXTURE_OAUTH2,
    ...overrides,
  };
}

function plainRoute(): ResolvedRoute {
  return {
    alias: 'plain',
    headers: { Authorization: 'Bearer static-token' },
    secrets: {},
    allowedEndpoints: ['https://api.plain.com/**'],
    resolveSecretsInBody: false,
  };
}

/** A controllable fake TokenManager. Records calls; returns queued tokens. */
function fakeTokenManager(tokens: string[]): {
  manager: TokenManager;
  calls: { forceRefresh: boolean }[];
} {
  const calls: { forceRefresh: boolean }[] = [];
  let i = 0;
  const manager = {
    getAccessToken: vi.fn(
      (_key: unknown, _oauth2: unknown, _resolve: unknown, opts?: { forceRefresh?: boolean }) => {
        calls.push({ forceRefresh: opts?.forceRefresh ?? false });
        const t = tokens[Math.min(i, tokens.length - 1)];
        i++;
        return Promise.resolve(t);
      },
    ),
    invalidate: vi.fn(),
  } as unknown as TokenManager;
  return { manager, calls };
}

/** Mock fetch Response with a configurable JSON body + status. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

describe('executeProxyRequest — OAuth2 wiring', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sets Authorization: Bearer <token> from the manager, overriding a template Authorization', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true }));
    const { manager, calls } = fakeTokenManager(['managed-token']);

    await executeProxyRequest(
      { method: 'GET', url: 'https://api.fixture.com/v1/me' },
      // route also has a (forbidden-for-card-4) static Authorization to prove override
      [oauthRoute({ headers: { Authorization: 'Bearer SHOULD-BE-OVERRIDDEN' } })],
      { tokenManager: manager, caller: 'alice' },
    );

    expect(calls).toEqual([{ forceRefresh: false }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer managed-token');
  });

  it('scopes the token key to (route alias, caller)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true }));
    const { manager } = fakeTokenManager(['t']);

    await executeProxyRequest(
      { method: 'GET', url: 'https://api.fixture.com/v1/me' },
      [oauthRoute()],
      { tokenManager: manager, caller: 'bob' },
    );

    const getAccessToken = (manager as unknown as { getAccessToken: ReturnType<typeof vi.fn> })
      .getAccessToken;
    const [key] = getAccessToken.mock.calls[0] as [{ connection: string; caller: string }];
    expect(key).toEqual({ connection: 'fixture', caller: 'bob' });
  });

  it('on 401, force-refreshes once and retries exactly once (success)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ error: 'unauthorized' }, 401))
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200));
    const { manager, calls } = fakeTokenManager(['stale-token', 'fresh-token']);

    const result = await executeProxyRequest(
      { method: 'GET', url: 'https://api.fixture.com/v1/me' },
      [oauthRoute()],
      { tokenManager: manager, caller: 'alice' },
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call no force, second call forceRefresh.
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it('on persistent 401, returns the 401 with NO infinite loop', async () => {
    fetchMock.mockResolvedValue(mockResponse({ error: 'unauthorized' }, 401));
    const { manager, calls } = fakeTokenManager(['t1', 't2']);

    const result = await executeProxyRequest(
      { method: 'GET', url: 'https://api.fixture.com/v1/me' },
      [oauthRoute()],
      { tokenManager: manager, caller: 'alice' },
    );

    expect(result.status).toBe(401);
    // Exactly two fetches (original + single retry), never more.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it('surfaces OAuth2InvalidGrantError as a re-auth error with no token material', async () => {
    const manager = {
      getAccessToken: vi.fn(() => Promise.reject(new OAuth2InvalidGrantError('fixture'))),
      invalidate: vi.fn(),
    } as unknown as TokenManager;

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.fixture.com/v1/me' }, [oauthRoute()], {
        tokenManager: manager,
        caller: 'alice',
      }),
    ).rejects.toThrow(/re-authorized/i);

    // No outbound API request was made (never fell through unauthenticated).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a transient OAuth2RefreshError as an auth failure (no silent unauthenticated request)', async () => {
    const manager = {
      getAccessToken: vi.fn(() => Promise.reject(new OAuth2RefreshError('fixture', 503))),
      invalidate: vi.fn(),
    } as unknown as TokenManager;

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.fixture.com/v1/me' }, [oauthRoute()], {
        tokenManager: manager,
        caller: 'alice',
      }),
    ).rejects.toThrow(/token refresh failed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never leaks token material into the surfaced error message', async () => {
    const manager = {
      getAccessToken: vi.fn(() => Promise.reject(new OAuth2InvalidGrantError('fixture'))),
      invalidate: vi.fn(),
    } as unknown as TokenManager;

    let captured = '';
    try {
      await executeProxyRequest(
        { method: 'GET', url: 'https://api.fixture.com/v1/me' },
        [oauthRoute()],
        { tokenManager: manager, caller: 'alice' },
      );
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    expect(captured).not.toContain('rt-val');
    expect(captured).not.toContain('secret-val');
    expect(captured).not.toContain('id-val');
  });

  // ── Regression: non-oauth2 path unchanged ──────────────────────────────────

  it('does NOT touch the token manager for a non-oauth2 route', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true }));
    const { manager } = fakeTokenManager(['unused']);

    const result = await executeProxyRequest(
      { method: 'GET', url: 'https://api.plain.com/v1/thing' },
      [plainRoute()],
      { tokenManager: manager, caller: 'alice' },
    );

    expect(result.status).toBe(200);
    expect(
      (manager as unknown as { getAccessToken: ReturnType<typeof vi.fn> }).getAccessToken,
    ).not.toHaveBeenCalled();
    // Static template Authorization preserved untouched.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer static-token');
  });

  it('does NOT retry a non-401 response on an oauth2 route', async () => {
    fetchMock.mockResolvedValue(mockResponse({ error: 'server' }, 500));
    const { manager, calls } = fakeTokenManager(['t']);

    const result = await executeProxyRequest(
      { method: 'GET', url: 'https://api.fixture.com/v1/me' },
      [oauthRoute()],
      { tokenManager: manager, caller: 'alice' },
    );

    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ forceRefresh: false }]);
  });
});
