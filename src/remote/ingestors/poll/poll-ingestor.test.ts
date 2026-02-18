/**
 * Unit tests for PollIngestor.
 *
 * Tests lifecycle management, HTTP request construction, response parsing
 * via responsePath, deduplication, error handling, and factory registration.
 *
 * Uses vi.stubGlobal('fetch', ...) to mock HTTP and vi.useFakeTimers()
 * for interval control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PollIngestor } from './poll-ingestor.js';
import { createIngestor } from '../registry.js';
import type { PollIngestorConfig, IngestorConfig } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock Response for fetch. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

/** Default poll config for tests. */
function defaultConfig(overrides: Partial<PollIngestorConfig> = {}): PollIngestorConfig {
  return {
    url: 'https://api.example.com/items',
    intervalMs: 10_000,
    ...overrides,
  };
}

/** Default route headers. */
const defaultRouteHeaders: Record<string, string> = {
  Authorization: 'Bearer test-token',
  'Content-Type': 'application/json',
};

/** Default secrets. */
const defaultSecrets: Record<string, string> = {
  API_KEY: 'secret-key-123',
};

// ── Tests ────────────────────────────────────────────────────────────

describe('PollIngestor', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(mockResponse([]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should set state to connected after successful first poll', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1', name: 'Item 1' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );

      await ingestor.start();
      expect(ingestor.getStatus().state).toBe('connected');

      await ingestor.stop();
    });

    it('should set state to stopped on stop', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );

      await ingestor.start();
      await ingestor.stop();
      expect(ingestor.getStatus().state).toBe('stopped');
    });

    it('should report type as poll in status', () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      expect(ingestor.getStatus().type).toBe('poll');
    });

    it('should report connection alias in status', () => {
      const ingestor = new PollIngestor(
        'my-notion',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      expect(ingestor.getStatus().connection).toBe('my-notion');
    });

    it('should clear interval timer on stop', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );

      await ingestor.start();
      await ingestor.stop();

      // Advance time well past the interval — no more fetch calls should happen
      const callCountAtStop = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(callCountAtStop);
    });

    it('should fire initial poll immediately on start', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      await ingestor.stop();
    });

    it('should fire subsequent polls on interval', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ intervalMs: 10_000 }),
        defaultRouteHeaders,
      );
      await ingestor.start();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // And another
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await ingestor.stop();
    });

    it('should enforce minimum interval of 5 seconds', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ intervalMs: 100 }),
        defaultRouteHeaders,
      );
      await ingestor.start();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // At 100ms (configured), should NOT have polled again
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // At 5000ms (enforced minimum), should poll
      await vi.advanceTimersByTimeAsync(4_900);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await ingestor.stop();
    });
  });

  // ── HTTP request construction ────────────────────────────────────

  describe('polling', () => {
    it('should make a GET request by default', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/items',
        expect.objectContaining({ method: 'GET' }),
      );
      await ingestor.stop();
    });

    it('should use configured HTTP method', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ method: 'POST' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'POST' }),
      );
      await ingestor.stop();
    });

    it('should include route headers in request', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      await ingestor.stop();
    });

    it('should include poll-specific headers, merged with route headers', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ headers: { 'X-Custom': 'value' } }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      expect(headers['X-Custom']).toBe('value');
      await ingestor.stop();
    });

    it('should send configured body for POST requests', async () => {
      const body = { query: 'test' };
      fetchMock.mockResolvedValue(mockResponse({ data: [] }));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ method: 'POST', body, responsePath: 'data' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      expect(fetchOptions.body).toBe(JSON.stringify(body));
      await ingestor.stop();
    });

    it('should not send body for GET requests even if configured', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ method: 'GET', body: { query: 'test' } }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      expect(fetchOptions.body).toBeUndefined();
      await ingestor.stop();
    });

    it('should resolve ${VAR} placeholders in URL', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ url: 'https://api.example.com/${API_KEY}/items' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.example.com/secret-key-123/items',
        expect.any(Object),
      );
      await ingestor.stop();
    });

    it('should resolve ${VAR} placeholders in body', async () => {
      fetchMock.mockResolvedValue(mockResponse([]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ method: 'POST', body: 'key=${API_KEY}' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      expect(fetchOptions.body).toBe('key=secret-key-123');
      await ingestor.stop();
    });

    it('should resolve ${VAR} placeholders in poll-specific headers', async () => {
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ headers: { 'X-Key': '${API_KEY}' } }),
        {},
      );
      await ingestor.start();

      const callArgs = fetchMock.mock.calls[0];
      const fetchOptions = callArgs[1] as RequestInit;
      const headers = fetchOptions.headers as Record<string, string>;
      expect(headers['X-Key']).toBe('secret-key-123');
      await ingestor.stop();
    });
  });

  // ── Response parsing ──────────────────────────────────────────────

  describe('response parsing', () => {
    it('should extract items from top-level array (no responsePath)', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }, { id: '2' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const events = ingestor.getEvents();
      expect(events).toHaveLength(2);
      await ingestor.stop();
    });

    it('should extract items via single-level responsePath', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({ results: [{ id: '1' }, { id: '2' }, { id: '3' }] }),
      );
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ responsePath: 'results', deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const events = ingestor.getEvents();
      expect(events).toHaveLength(3);
      await ingestor.stop();
    });

    it('should extract items via multi-level responsePath', async () => {
      fetchMock.mockResolvedValue(
        mockResponse({
          data: {
            issues: {
              nodes: [{ id: 'a' }, { id: 'b' }],
            },
          },
        }),
      );
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ responsePath: 'data.issues.nodes', deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const events = ingestor.getEvents();
      expect(events).toHaveLength(2);
      await ingestor.stop();
    });

    it('should treat missing responsePath result as error', async () => {
      fetchMock.mockResolvedValue(mockResponse({ other: 'data' }));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ responsePath: 'results' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      // Should be in reconnecting state due to error
      expect(ingestor.getStatus().state).toBe('reconnecting');
      expect(ingestor.getEvents()).toHaveLength(0);
      await ingestor.stop();
    });

    it('should treat non-array at responsePath as error', async () => {
      fetchMock.mockResolvedValue(mockResponse({ results: 'not-an-array' }));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ responsePath: 'results' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('reconnecting');
      await ingestor.stop();
    });

    it('should assign configured eventType to all events', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ eventType: 'page_updated', deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const events = ingestor.getEvents();
      expect(events[0].eventType).toBe('page_updated');
      await ingestor.stop();
    });

    it('should default eventType to "poll"', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const events = ingestor.getEvents();
      expect(events[0].eventType).toBe('poll');
      await ingestor.stop();
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────

  describe('deduplication', () => {
    it('should push new items and skip duplicates based on deduplicateBy', async () => {
      const items = [{ id: '1' }, { id: '2' }, { id: '3' }];
      fetchMock.mockResolvedValue(mockResponse(items));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );

      // First poll: all 3 items are new
      await ingestor.start();
      expect(ingestor.getEvents()).toHaveLength(3);

      // Second poll: same items → no new events
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getEvents()).toHaveLength(3); // Still 3, no duplicates

      await ingestor.stop();
    });

    it('should push all items when deduplicateBy is not configured', async () => {
      const items = [{ id: '1' }, { id: '2' }];
      fetchMock.mockResolvedValue(mockResponse(items));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );

      // First poll
      await ingestor.start();
      expect(ingestor.getEvents()).toHaveLength(2);

      // Second poll: same items pushed again (no dedup)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getEvents()).toHaveLength(4);

      await ingestor.stop();
    });

    it('should handle items without the deduplicateBy field (push them)', async () => {
      const items = [{ name: 'no-id' }, { id: '1' }, { name: 'also-no-id' }];
      fetchMock.mockResolvedValue(mockResponse(items));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );

      await ingestor.start();
      // Items without 'id' field should be pushed (fail-open)
      expect(ingestor.getEvents()).toHaveLength(3);

      // Second poll: item with id='1' is skipped, items without id are pushed again
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getEvents()).toHaveLength(5); // 3 + 2 (no-id items re-pushed)

      await ingestor.stop();
    });

    it('should handle numeric deduplicateBy values (stringify)', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: 42 }, { id: 43 }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );

      await ingestor.start();
      expect(ingestor.getEvents()).toHaveLength(2);

      // Same numeric IDs should be deduplicated
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getEvents()).toHaveLength(2);

      await ingestor.stop();
    });

    it('should detect new items in subsequent polls', async () => {
      const poll1 = [{ id: '1' }, { id: '2' }];
      const poll2 = [{ id: '2' }, { id: '3' }]; // '2' is dup, '3' is new

      fetchMock
        .mockResolvedValueOnce(mockResponse(poll1))
        .mockResolvedValueOnce(mockResponse(poll2));

      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );

      await ingestor.start();
      expect(ingestor.getEvents()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getEvents()).toHaveLength(3); // 2 original + 1 new

      await ingestor.stop();
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('should set state to reconnecting on transient HTTP error', async () => {
      fetchMock.mockResolvedValue(mockResponse({}, 500));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('reconnecting');
      await ingestor.stop();
    });

    it('should continue polling after transient error', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({}, 500))
        .mockResolvedValueOnce(mockResponse([{ id: '1' }]));

      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('reconnecting');

      // Next poll succeeds
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ingestor.getStatus().state).toBe('connected');
      expect(ingestor.getEvents()).toHaveLength(1);

      await ingestor.stop();
    });

    it('should set state to error after MAX_CONSECUTIVE_ERRORS', async () => {
      fetchMock.mockResolvedValue(mockResponse({}, 500));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ intervalMs: 10_000 }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      // Initial poll + 9 more = 10 total consecutive errors
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(ingestor.getStatus().state).toBe('error');
      expect(ingestor.getStatus().error).toBeDefined();

      await ingestor.stop();
    });

    it('should stop timer after MAX_CONSECUTIVE_ERRORS', async () => {
      fetchMock.mockResolvedValue(mockResponse({}, 500));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ intervalMs: 10_000 }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      // Trigger 9 more errors (10 total including initial)
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(ingestor.getStatus().state).toBe('error');
      const callCount = fetchMock.mock.calls.length;

      // No more polls should happen
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock.mock.calls.length).toBe(callCount);

      await ingestor.stop();
    });

    it('should reset consecutive errors on successful poll', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({}, 500)) // error 1
        .mockResolvedValueOnce(mockResponse({}, 500)) // error 2
        .mockResolvedValueOnce(mockResponse([])) // success
        .mockResolvedValueOnce(mockResponse({}, 500)); // error 1 (reset)

      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ intervalMs: 10_000 }),
        defaultRouteHeaders,
      );
      await ingestor.start(); // error 1

      await vi.advanceTimersByTimeAsync(10_000); // error 2
      expect(ingestor.getStatus().state).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(10_000); // success
      expect(ingestor.getStatus().state).toBe('connected');

      await vi.advanceTimersByTimeAsync(10_000); // error 1 again (not 3)
      expect(ingestor.getStatus().state).toBe('reconnecting');
      // Should NOT be in 'error' state since counter was reset

      await ingestor.stop();
    });

    it('should handle network errors (fetch throws)', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('reconnecting');
      expect(ingestor.getStatus().error).toBe('Network error');
      await ingestor.stop();
    });

    it('should handle invalid JSON response', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig(),
        defaultRouteHeaders,
      );
      await ingestor.start();

      expect(ingestor.getStatus().state).toBe('reconnecting');
      await ingestor.stop();
    });
  });

  // ── Cursor-based retrieval ────────────────────────────────────────

  describe('cursor-based retrieval', () => {
    it('should support getEvents(afterId) for cursor-based polling', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }, { id: '2' }, { id: '3' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const allEvents = ingestor.getEvents();
      expect(allEvents).toHaveLength(3);

      // Get only events after the first one
      const afterFirst = ingestor.getEvents(allEvents[0].id);
      expect(afterFirst).toHaveLength(2);

      await ingestor.stop();
    });

    it('should report totalEventsReceived and bufferedEvents in status', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }, { id: '2' }]));
      const ingestor = new PollIngestor(
        'test',
        defaultSecrets,
        defaultConfig({ deduplicateBy: 'id' }),
        defaultRouteHeaders,
      );
      await ingestor.start();

      const status = ingestor.getStatus();
      expect(status.totalEventsReceived).toBe(2);
      expect(status.bufferedEvents).toBe(2);
      expect(status.lastEventAt).not.toBeNull();

      await ingestor.stop();
    });
  });
});

// ── Static method tests ─────────────────────────────────────────────

describe('PollIngestor.resolvePlaceholders', () => {
  it('should replace known placeholders', () => {
    const result = PollIngestor.resolvePlaceholders('Bearer ${TOKEN}', { TOKEN: 'abc123' });
    expect(result).toBe('Bearer abc123');
  });

  it('should leave unknown placeholders unchanged', () => {
    const result = PollIngestor.resolvePlaceholders('${KNOWN} and ${UNKNOWN}', { KNOWN: 'found' });
    expect(result).toBe('found and ${UNKNOWN}');
  });

  it('should handle multiple placeholders', () => {
    const result = PollIngestor.resolvePlaceholders('${A}/${B}/${A}', { A: 'x', B: 'y' });
    expect(result).toBe('x/y/x');
  });

  it('should handle strings with no placeholders', () => {
    const result = PollIngestor.resolvePlaceholders('no placeholders here', { TOKEN: 'abc' });
    expect(result).toBe('no placeholders here');
  });
});

// ── Factory registration ────────────────────────────────────────────

describe('Poll factory registration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse([])));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should create a PollIngestor via createIngestor with type poll', () => {
    const config: IngestorConfig = {
      type: 'poll',
      poll: {
        url: 'https://api.example.com/items',
        intervalMs: 60_000,
      },
    };
    const ingestor = createIngestor('test-poll', config, { API_KEY: 'test' });
    expect(ingestor).toBeInstanceOf(PollIngestor);
  });

  it('should return null when poll config is missing', () => {
    const config: IngestorConfig = {
      type: 'poll',
      // poll field intentionally omitted
    };
    const ingestor = createIngestor('test-poll', config, {});
    expect(ingestor).toBeNull();
  });
});
