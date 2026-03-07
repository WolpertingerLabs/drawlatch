/**
 * Unit tests for the WebhookLifecycleManager.
 *
 * Tests cover:
 * - ensureRegistered: no existing webhooks (register new)
 * - ensureRegistered: matching webhook exists (reuse)
 * - ensureRegistered: stale webhook exists (cleanup + register new)
 * - ensureRegistered: list fails → fallback to direct register
 * - ensureRegistered: register fails → returns error state
 * - unregister: success and failure paths
 * - Placeholder resolution in URLs and body
 * - responsePath support for nested arrays
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookLifecycleManager } from './webhook-lifecycle-manager.js';
import type { WebhookLifecycleConfig } from './lifecycle-types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const CALLBACK_URL = 'https://my-tunnel.trycloudflare.com/webhooks/trello';
const BOARD_ID = 'board-abc-123';
const WEBHOOK_ID = 'webhook-xyz-789';

function makeConfig(overrides?: Partial<WebhookLifecycleConfig>): WebhookLifecycleConfig {
  return {
    list: {
      method: 'GET',
      url: 'https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}',
      callbackUrlField: 'callbackURL',
      idField: 'id',
      modelIdField: 'idModel',
    },
    register: {
      method: 'POST',
      url: 'https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}',
      headers: { 'Content-Type': 'application/json' },
      body: {
        callbackURL: '${TRELLO_CALLBACK_URL}',
        idModel: '${boardId}',
        description: 'Drawlatch webhook',
      },
      idField: 'id',
    },
    unregister: {
      method: 'DELETE',
      url: 'https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/${_webhookId}?key=${TRELLO_API_KEY}',
    },
    ...overrides,
  };
}

const TEST_SECRETS: Record<string, string> = {
  TRELLO_API_KEY: 'test-api-key',
  TRELLO_TOKEN: 'test-token',
  TRELLO_CALLBACK_URL: CALLBACK_URL,
  boardId: BOARD_ID,
};

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('WebhookLifecycleManager', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── ensureRegistered ─────────────────────────────────────────────────

  describe('ensureRegistered', () => {
    it('should register a new webhook when no existing webhooks found', async () => {
      // List returns empty array
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));
      // Register returns new webhook
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ id: WEBHOOK_ID }));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
      expect(result.lastAttempt).toBeDefined();

      // Verify list was called
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const listCall = fetchSpy.mock.calls[0];
      expect(listCall[0]).toBe(
        'https://api.trello.com/1/tokens/test-token/webhooks?key=test-api-key',
      );
      expect(listCall[1].method).toBe('GET');

      // Verify register was called with resolved body
      const registerCall = fetchSpy.mock.calls[1];
      expect(registerCall[1].method).toBe('POST');
      const registerBody = JSON.parse(registerCall[1].body as string);
      expect(registerBody.callbackURL).toBe(CALLBACK_URL);
      expect(registerBody.idModel).toBe(BOARD_ID);
      expect(registerBody.description).toBe('Drawlatch webhook');
    });

    it('should reuse an existing matching webhook', async () => {
      // List returns matching webhook
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse([
          {
            id: WEBHOOK_ID,
            callbackURL: CALLBACK_URL,
            idModel: BOARD_ID,
          },
        ]),
      );

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);

      // Only list was called (no register)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should clean up stale webhooks and register a new one', async () => {
      const staleWebhookId = 'stale-webhook-old';
      const oldCallbackUrl = 'https://old-tunnel.trycloudflare.com/webhooks/trello';

      // List returns stale webhook (same model, wrong callback URL)
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse([
          {
            id: staleWebhookId,
            callbackURL: oldCallbackUrl,
            idModel: BOARD_ID,
          },
        ]),
      );
      // Unregister stale webhook
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));
      // Register new webhook
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ id: WEBHOOK_ID }));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Verify unregister was called for stale webhook
      const unregisterCall = fetchSpy.mock.calls[1];
      expect(unregisterCall[1].method).toBe('DELETE');
      expect(unregisterCall[0]).toContain(staleWebhookId);
    });

    it('should attempt direct register when list fails', async () => {
      // List fails
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'unauthorized' }, 401));
      // Register succeeds
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ id: WEBHOOK_ID }));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should return error state when register fails', async () => {
      // List returns empty
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));
      // Register fails
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'Bad request' }, 400));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(false);
      expect(result.error).toContain('Register failed (400)');
      expect(result.lastAttempt).toBeDefined();
    });

    it('should return error state when register response lacks idField', async () => {
      // List returns empty
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));
      // Register returns response without id field
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(false);
      expect(result.error).toContain('missing "id" field');
    });

    it('should handle network errors gracefully', async () => {
      // List throws network error
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      // Register also throws (both fail scenario)
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should work without list config (direct register)', async () => {
      const config = makeConfig({ list: undefined });

      // Register succeeds
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ id: WEBHOOK_ID }));

      const manager = new WebhookLifecycleManager(config, TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should return error when no register config defined', async () => {
      const config = makeConfig({ register: undefined });

      // List returns empty
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));

      const manager = new WebhookLifecycleManager(config, TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      expect(result.registered).toBe(false);
      expect(result.error).toContain('No register config');
    });

    it('should match by callback URL only when no modelId provided', async () => {
      // List returns webhook matching callbackUrl but different model
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse([
          {
            id: WEBHOOK_ID,
            callbackURL: CALLBACK_URL,
            idModel: 'different-board',
          },
        ]),
      );

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      // No modelId → match by callbackUrl only
      const result = await manager.ensureRegistered(CALLBACK_URL);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── unregister ───────────────────────────────────────────────────────

  describe('unregister', () => {
    it('should unregister a webhook by ID', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, 200));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      await manager.unregister(WEBHOOK_ID);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call[1].method).toBe('DELETE');
      expect(call[0]).toBe(
        `https://api.trello.com/1/tokens/test-token/webhooks/${WEBHOOK_ID}?key=test-api-key`,
      );
    });

    it('should not throw when unregister fails', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'not found' }, 404));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      // Should not throw
      await expect(manager.unregister(WEBHOOK_ID)).resolves.toBeUndefined();
    });

    it('should not throw when unregister request errors', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      await expect(manager.unregister(WEBHOOK_ID)).resolves.toBeUndefined();
    });

    it('should skip when no unregister config defined', async () => {
      const config = makeConfig({ unregister: undefined });
      const manager = new WebhookLifecycleManager(config, TEST_SECRETS);
      await manager.unregister(WEBHOOK_ID);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── Placeholder resolution ────────────────────────────────────────────

  describe('placeholder resolution', () => {
    it('should resolve ${VAR} placeholders in list URL', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse([{ id: WEBHOOK_ID, callbackURL: CALLBACK_URL }]),
      );

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      await manager.ensureRegistered(CALLBACK_URL);

      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('https://api.trello.com/1/tokens/test-token/webhooks?key=test-api-key');
    });

    it('should resolve ${VAR} placeholders in register body', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse([]));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ id: WEBHOOK_ID }));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      await manager.ensureRegistered(CALLBACK_URL, BOARD_ID);

      const registerCall = fetchSpy.mock.calls[1];
      const body = JSON.parse(registerCall[1].body as string);
      expect(body.callbackURL).toBe(CALLBACK_URL);
      expect(body.idModel).toBe(BOARD_ID);
    });

    it('should resolve ${_webhookId} in unregister URL', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      const manager = new WebhookLifecycleManager(makeConfig(), TEST_SECRETS);
      await manager.unregister('my-webhook-id');

      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toContain('/webhooks/my-webhook-id?');
    });
  });

  // ── responsePath support ──────────────────────────────────────────────

  describe('responsePath', () => {
    it('should extract webhooks from nested response path', async () => {
      const config = makeConfig({
        list: {
          method: 'GET',
          url: 'https://api.example.com/webhooks',
          callbackUrlField: 'url',
          idField: 'id',
          responsePath: 'data.webhooks',
        },
      });

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          data: {
            webhooks: [{ id: WEBHOOK_ID, url: CALLBACK_URL }],
          },
        }),
      );

      const manager = new WebhookLifecycleManager(config, TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL);

      expect(result.registered).toBe(true);
      expect(result.webhookId).toBe(WEBHOOK_ID);
    });

    it('should return error when responsePath yields non-array', async () => {
      const config = makeConfig({
        list: {
          method: 'GET',
          url: 'https://api.example.com/webhooks',
          callbackUrlField: 'url',
          idField: 'id',
          responsePath: 'data.webhooks',
        },
      });

      // List returns non-array at responsePath → listWebhooks throws
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ data: { webhooks: 'not an array' } }));
      // Falls through to register, which also fails
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ error: 'Bad request' }, 400));

      const manager = new WebhookLifecycleManager(config, TEST_SECRETS);
      const result = await manager.ensureRegistered(CALLBACK_URL);

      expect(result.registered).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
