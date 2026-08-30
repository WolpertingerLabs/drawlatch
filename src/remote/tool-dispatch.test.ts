/**
 * Unit tests for outbound request timeout resolution in tool-dispatch.ts.
 *
 * The three nested ceilings must fire innermost-first
 * (`upstream < local → remote < MCP client`) so that the only layer able to
 * cancel the upstream API call is the one that expires first. These tests pin
 * the precedence, clamping, and malformed-input behavior of that innermost
 * deadline.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ResolvedRoute } from '../shared/config.js';

import {
  resolveOutboundTimeout,
  executeProxyRequest,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  MAX_OUTBOUND_TIMEOUT_MS,
} from './tool-dispatch.js';

// ── resolveOutboundTimeout ─────────────────────────────────────────────────

describe('resolveOutboundTimeout', () => {
  describe('fallback', () => {
    it('should use the module default when neither caller nor route specifies one', () => {
      expect(resolveOutboundTimeout(undefined, undefined)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
    });

    it('should keep the default below the local proxy default (30s) and MCP cap (60s)', () => {
      expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBeLessThan(30_000);
    });
  });

  describe('precedence', () => {
    it('should prefer the route value over the module default', () => {
      expect(resolveOutboundTimeout(undefined, 120_000)).toBe(120_000);
    });

    it('should prefer the caller value over the module default', () => {
      expect(resolveOutboundTimeout(10_000, undefined)).toBe(10_000);
    });

    it('should prefer the caller value over the route value', () => {
      expect(resolveOutboundTimeout(45_000, 120_000)).toBe(45_000);
    });

    it('should let the caller request less than the route default', () => {
      expect(resolveOutboundTimeout(5_000, 180_000)).toBe(5_000);
    });
  });

  describe('clamping', () => {
    it('should clamp a caller value to the route ceiling', () => {
      expect(resolveOutboundTimeout(500_000, 120_000)).toBe(120_000);
    });

    it('should allow a caller value exactly at the route ceiling', () => {
      expect(resolveOutboundTimeout(120_000, 120_000)).toBe(120_000);
    });

    it('should clamp a caller value to the global max when the route sets none', () => {
      expect(resolveOutboundTimeout(999_999_999, undefined)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });

    it('should clamp a route value above the global max', () => {
      expect(resolveOutboundTimeout(undefined, 999_999_999)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });

    it('should clamp a caller value to the global max when the route ceiling also exceeds it', () => {
      expect(resolveOutboundTimeout(999_999_999, 999_999_999)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });
  });

  describe('malformed values', () => {
    it.each([0, -1, -60_000, NaN, Infinity, -Infinity])(
      'should ignore a caller value of %p and fall back to the route value',
      (bad) => {
        expect(resolveOutboundTimeout(bad, 120_000)).toBe(120_000);
      },
    );

    it.each([0, -1, NaN, Infinity])(
      'should ignore a caller value of %p and fall back to the module default',
      (bad) => {
        expect(resolveOutboundTimeout(bad, undefined)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
      },
    );

    it.each([0, -1, NaN, Infinity])(
      'should ignore a route value of %p and fall back to the module default',
      (bad) => {
        expect(resolveOutboundTimeout(undefined, bad)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
      },
    );

    it('should not treat a malformed route value as a ceiling on a valid caller value', () => {
      expect(resolveOutboundTimeout(90_000, 0)).toBe(90_000);
    });
  });
});

// ── executeProxyRequest: outbound signal ───────────────────────────────────

function testRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    alias: 'test',
    headers: {},
    secrets: {},
    allowedEndpoints: ['https://api.example.com/**'],
    resolveSecretsInBody: false,
    ...overrides,
  };
}

/** Stub fetch, capture the init it was called with, return an empty 200. */
function stubFetch() {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return spy;
}

describe('executeProxyRequest outbound timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should always pass an abort signal (never a bare fetch)', async () => {
    const spy = stubFetch();

    await executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/thing' }, [
      testRoute(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('should surface a timeout as a drawlatch error naming the URL and the deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    await expect(
      executeProxyRequest(
        { method: 'POST', url: 'https://api.example.com/v1/slow', timeoutMs: 1_500 },
        [testRoute()],
      ),
    ).rejects.toThrow(
      'Upstream request timed out after 1500ms: POST https://api.example.com/v1/slow',
    );
  });

  it('should report the clamped deadline, not the requested one', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    await expect(
      executeProxyRequest(
        { method: 'GET', url: 'https://api.example.com/v1/slow', timeoutMs: 900_000 },
        [testRoute({ requestTimeoutMs: 60_000 })],
      ),
    ).rejects.toThrow('timed out after 60000ms');
  });

  it('should report the caller URL, not the secret-resolved URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x?token=${TOKEN}' }, [
        testRoute({
          secrets: { TOKEN: 'super-secret-value' },
          allowedEndpoints: ['https://api.example.com/**'],
        }),
      ]),
    ).rejects.toThrow(/\$\{TOKEN\}/);
  });

  it('should pass through non-timeout errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow('fetch failed');
  });
});
