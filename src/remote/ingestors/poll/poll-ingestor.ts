/**
 * Polling ingestor — interval-based HTTP poller.
 *
 * Periodically hits an HTTP endpoint using the connection's resolved
 * secrets and headers, extracts individual items from the response,
 * deduplicates by a configurable field, and pushes new items into
 * the ring buffer.
 *
 * Unlike WebSocket ingestors (which maintain persistent connections)
 * or webhook ingestors (which are passive receivers), poll ingestors
 * are active requesters on a timer.
 *
 * Designed as a single concrete class — all service-specific behavior
 * (response shape, event type, deduplication field) is parameterized
 * via `PollIngestorConfig` rather than requiring subclasses.
 *
 * @see https://developers.notion.com/reference (Notion — first implementor)
 * @see https://developers.linear.app/docs/graphql/working-with-the-graphql-api (Linear — first implementor)
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { PollIngestorConfig } from '../types.js';
import { registerIngestorFactory } from '../registry.js';
import { createLogger } from '../../../shared/logger.js';
import type { OAuth2Config } from '../../../shared/config.js';
import type { TokenManager } from '../../oauth/token-manager.js';
import { getSharedTokenManager } from '../../oauth/shared-token-manager.js';

const log = createLogger('poll');

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum number of seen IDs to track for deduplication.
 *  When exceeded, oldest entries are pruned. */
const MAX_SEEN_IDS = 10_000;

/** Minimum allowed poll interval (to prevent accidental API flooding). */
const MIN_INTERVAL_MS = 5_000; // 5 seconds

/** Maximum consecutive errors before transitioning to 'error' state. */
const MAX_CONSECUTIVE_ERRORS = 10;

// ── Poll Ingestor ─────────────────────────────────────────────────────

export class PollIngestor extends BaseIngestor {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seenIds = new Set<string>();
  private consecutiveErrors = 0;

  private readonly url: string;
  private readonly intervalMs: number;
  private readonly method: string;
  private readonly body: unknown;
  private readonly deduplicateBy: string | undefined;
  private readonly responsePath: string | undefined;
  private readonly eventType: string;
  private readonly pollHeaders: Record<string, string>;
  private readonly useEtag: boolean;
  private lastEtag: string | null = null;

  /** Resolved headers from the parent connection route (injected by manager). */
  private readonly routeHeaders: Record<string, string>;

  /** OAuth2 declaration for this route, when the connection uses managed tokens. */
  private readonly oauth2?: OAuth2Config;
  /** Caller alias the OAuth2 token is scoped to (the (connection, caller) key). */
  private readonly oauth2Caller: string;
  /** Shared token manager (same instance the request path uses). */
  private readonly tokenManager: TokenManager;

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    pollConfig: PollIngestorConfig,
    /** Pre-resolved headers from the connection's route. */
    routeHeaders: Record<string, string>,
    bufferSize?: number,
    instanceId?: string,
    /** OAuth2 wiring (omitted for non-oauth2 routes — behaviour unchanged). */
    oauth2Options?: {
      oauth2?: OAuth2Config;
      caller?: string;
      tokenManager?: TokenManager;
    },
  ) {
    super(connectionAlias, 'poll', secrets, bufferSize, instanceId);
    this.oauth2 = oauth2Options?.oauth2;
    this.oauth2Caller = oauth2Options?.caller ?? 'unknown';
    this.tokenManager = oauth2Options?.tokenManager ?? getSharedTokenManager();

    // Resolve ${VAR} placeholders in URL
    this.url = PollIngestor.resolvePlaceholders(pollConfig.url, secrets);
    this.intervalMs = Math.max(pollConfig.intervalMs, MIN_INTERVAL_MS);
    this.method = (pollConfig.method ?? 'GET').toUpperCase();
    this.body = pollConfig.body;
    this.deduplicateBy = pollConfig.deduplicateBy;
    this.responsePath = pollConfig.responsePath;
    this.eventType = pollConfig.eventType ?? 'poll';
    this.useEtag = pollConfig.etag ?? false;
    this.routeHeaders = routeHeaders;

    // Resolve ${VAR} placeholders in poll-specific headers
    this.pollHeaders = {};
    if (pollConfig.headers) {
      for (const [k, v] of Object.entries(pollConfig.headers)) {
        this.pollHeaders[k] = PollIngestor.resolvePlaceholders(v, secrets);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.state = 'starting';
    log.info(
      `Starting poll ingestor for ${this.connectionAlias} ` +
        `(${this.method} ${this.url}, every ${this.intervalMs}ms)`,
    );

    // Do an initial poll immediately
    await this.poll();

    // Then set up the recurring interval
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);

    // If the initial poll succeeded, state is already 'connected'.
    // If it failed, state is 'reconnecting' — the timer will retry.
  }

  stop(_permanent?: boolean): Promise<void> {
    this.state = 'stopped';
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    return Promise.resolve();
  }

  // ── Core poll logic ──────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      // Build headers: route headers (from connection template) merged with poll-specific headers
      const headers: Record<string, string> = {
        ...this.routeHeaders,
        ...this.pollHeaders,
      };

      // Add ETag conditional request header if enabled and we have a cached ETag
      if (this.useEtag && this.lastEtag) {
        headers['If-None-Match'] = this.lastEtag;
      }

      // Build request options
      const fetchOptions: RequestInit = {
        method: this.method,
        headers,
      };

      // Add body for POST/PUT/PATCH
      if (this.body !== undefined && this.method !== 'GET' && this.method !== 'HEAD') {
        if (typeof this.body === 'string') {
          fetchOptions.body = PollIngestor.resolvePlaceholders(this.body, this.secrets);
        } else {
          const serialized = JSON.stringify(this.body);
          fetchOptions.body = PollIngestor.resolvePlaceholders(serialized, this.secrets);
          // Ensure Content-Type is set for JSON bodies
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
          }
        }
      }

      // OAuth2 routes: inject a managed Bearer token before fetching. The
      // managed token OVERRIDES any Authorization header from the template
      // (same precedence contract as the request path — Card 4 templates must
      // NOT declare a static Authorization header on an oauth2 route).
      if (this.oauth2) {
        const token = await this.resolveOAuthToken(false);
        PollIngestor.applyBearer(headers, token);
      }

      let response = await fetch(this.url, fetchOptions);

      // OAuth2 401 recovery: force ONE refresh + ONE retry of this poll, guarded
      // so it can never loop and so a 401 triggers a real token refresh rather
      // than burning the consecutive-error retry budget on repeated 401s.
      if (this.oauth2 && response.status === 401) {
        const fresh = await this.resolveOAuthToken(true);
        PollIngestor.applyBearer(headers, fresh);
        response = await fetch(this.url, fetchOptions);
        // If still 401, fall through to the normal !response.ok handling below —
        // we never retry a second time.
      }

      // Handle ETag 304 Not Modified — no new data, not an error
      if (this.useEtag && response.status === 304) {
        this.consecutiveErrors = 0;
        if (this.state !== 'connected') this.state = 'connected';
        log.debug(`${this.connectionAlias}: 304 Not Modified (ETag cache hit)`);
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Store ETag for subsequent conditional requests
      if (this.useEtag) {
        const etag = response.headers.get('etag');
        if (etag) this.lastEtag = etag;
      }

      const responseBody: unknown = await response.json();

      // Extract items array from response using responsePath
      const items = this.extractItems(responseBody);

      if (!Array.isArray(items)) {
        throw new Error(
          `Expected array at responsePath "${this.responsePath ?? '(root)'}", got ${typeof items}`,
        );
      }

      // Process each item
      let newItemCount = 0;
      for (const item of items) {
        if (this.shouldPush(item)) {
          const idempotencyKey = this.extractItemIdempotencyKey(item);
          this.pushEvent(this.eventType, item, idempotencyKey);
          newItemCount++;
        }
      }

      // Success — reset error state
      this.consecutiveErrors = 0;
      if (this.state !== 'connected') {
        this.state = 'connected';
      }

      if (newItemCount > 0) {
        log.info(`${this.connectionAlias}: ${newItemCount} new item(s) from ${items.length} total`);
      }
      log.debug(
        `${this.connectionAlias}: poll complete — ${items.length} items, ${newItemCount} new`,
      );
    } catch (err) {
      this.consecutiveErrors++;
      const message = err instanceof Error ? err.message : String(err);
      this.errorMessage = message;

      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.state = 'error';
        log.error(
          `${this.connectionAlias}: ${MAX_CONSECUTIVE_ERRORS} consecutive errors, giving up: ${message}`,
        );
        // Stop the timer on permanent error
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      } else {
        this.state = 'reconnecting';
        log.warn(
          `${this.connectionAlias}: poll failed (attempt ${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${message}`,
        );
      }
    }
  }

  // ── Response parsing ──────────────────────────────────────────────

  /**
   * Extract items from the response using the configured responsePath.
   * E.g., "results" extracts response.results,
   * "data.issues.nodes" extracts response.data.issues.nodes.
   * If no responsePath, returns the response itself (expects a top-level array).
   */
  private extractItems(responseBody: unknown): unknown {
    if (!this.responsePath) return responseBody;

    const parts = this.responsePath.split('.');
    let current: unknown = responseBody;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  // ── Deduplication ──────────────────────────────────────────────────

  /**
   * Resolve a dot-separated path on an object.
   * E.g., "data.name" on { data: { name: "t3_abc" } } → "t3_abc".
   * Single-segment paths (e.g., "id") resolve as a simple property lookup.
   */
  private static resolveNestedPath(obj: unknown, dotPath: string): unknown {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;

    const parts = dotPath.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Check if an item should be pushed into the buffer (dedup check).
   * Returns true if the item is new (not previously seen).
   * Supports dot-separated paths in `deduplicateBy` (e.g., "data.name").
   */
  private shouldPush(item: unknown): boolean {
    if (!this.deduplicateBy) return true;

    const idValue = PollIngestor.resolveNestedPath(item, this.deduplicateBy);
    if (idValue === undefined || idValue === null) return true;

    // Ensure safe stringification: only accept primitives for dedup IDs
    const id =
      typeof idValue === 'string' || typeof idValue === 'number' || typeof idValue === 'boolean'
        ? String(idValue)
        : JSON.stringify(idValue);

    if (this.seenIds.has(id)) return false;

    // Add to seen set, prune if over limit
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_SEEN_IDS) {
      this.pruneSeenIds();
    }

    return true;
  }

  /**
   * Prune the seen IDs set to prevent unbounded memory growth.
   * Removes the oldest half of entries. Since Set preserves insertion order,
   * we can iterate and delete the first N entries.
   */
  private pruneSeenIds(): void {
    const pruneCount = Math.floor(this.seenIds.size / 2);
    let removed = 0;
    for (const id of this.seenIds) {
      if (removed >= pruneCount) break;
      this.seenIds.delete(id);
      removed++;
    }
    log.debug(
      `${this.connectionAlias}: pruned ${removed} seen IDs (${this.seenIds.size} remaining)`,
    );
  }

  // ── Idempotency ─────────────────────────────────────────────────

  /**
   * Extract an idempotency key from a poll item using the `deduplicateBy` field.
   * Supports dot-separated paths (e.g., "data.name").
   * Returns `undefined` if no dedup field is configured or the field is absent.
   */
  private extractItemIdempotencyKey(item: unknown): string | undefined {
    if (!this.deduplicateBy) return undefined;

    const idValue = PollIngestor.resolveNestedPath(item, this.deduplicateBy);
    if (idValue === undefined || idValue === null) return undefined;

    const id =
      typeof idValue === 'string' || typeof idValue === 'number' || typeof idValue === 'boolean'
        ? String(idValue)
        : JSON.stringify(idValue);

    return `poll:${this.connectionAlias}:${id}`;
  }

  // ── OAuth2 token injection ──────────────────────────────────────────

  /**
   * Obtain a managed access token for this route's oauth2 block via the shared
   * TokenManager, scoped to (connection, caller). Secrets are resolved against
   * this ingestor's already-resolved secret map — the same `(name) =>
   * secrets[name]` semantics the request path uses. Never logs token material.
   *
   * @param forceRefresh  After a 401, force exactly one refresh (preserving a
   *                       rotated refresh token — NOT invalidate()).
   */
  private resolveOAuthToken(forceRefresh: boolean): Promise<string> {
    // `this.oauth2` is guaranteed defined by the caller's guard.
    return this.tokenManager.getAccessToken(
      { connection: this.connectionAlias, caller: this.oauth2Caller },
      this.oauth2!,
      (name) => this.secrets[name],
      { forceRefresh },
    );
  }

  /** Set `Authorization: Bearer <token>`, overriding any existing casing. */
  private static applyBearer(headers: Record<string, string>, token: string): void {
    delete headers.Authorization;
    delete headers.authorization;
    headers.Authorization = `Bearer ${token}`;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Resolve ${VAR} placeholders in a string using a secrets map.
   */
  static resolvePlaceholders(str: string, secrets: Record<string, string>): string {
    return str.replace(/\$\{(\w+)\}/g, (match, name: string) => {
      if (name in secrets) return secrets[name];
      return match;
    });
  }
}

// ── Self-registration ──────────────────────────────────────────────────

registerIngestorFactory('poll', (connectionAlias, config, secrets, bufferSize, instanceId) => {
  if (!config.poll) {
    log.error(`Missing poll config for ${connectionAlias}`);
    return null;
  }

  return new PollIngestor(
    connectionAlias,
    secrets,
    config.poll,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-condition -- route headers injected by manager via private property; may be absent
    ((config as any)._resolvedRouteHeaders as Record<string, string>) ?? {},
    bufferSize,
    instanceId,
    {
      // oauth2 + caller injected by the manager via private properties; absent
      // for non-oauth2 routes (tokenManager defaults to the shared instance).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      oauth2: (config as any)._oauth2 as OAuth2Config | undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      caller: (config as any)._oauth2Caller as string | undefined,
    },
  );
});
