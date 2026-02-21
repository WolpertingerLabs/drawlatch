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

  /** Resolved headers from the parent connection route (injected by manager). */
  private readonly routeHeaders: Record<string, string>;

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    pollConfig: PollIngestorConfig,
    /** Pre-resolved headers from the connection's route. */
    routeHeaders: Record<string, string>,
    bufferSize?: number,
  ) {
    super(connectionAlias, 'poll', secrets, bufferSize);

    // Resolve ${VAR} placeholders in URL
    this.url = PollIngestor.resolvePlaceholders(pollConfig.url, secrets);
    this.intervalMs = Math.max(pollConfig.intervalMs, MIN_INTERVAL_MS);
    this.method = (pollConfig.method ?? 'GET').toUpperCase();
    this.body = pollConfig.body;
    this.deduplicateBy = pollConfig.deduplicateBy;
    this.responsePath = pollConfig.responsePath;
    this.eventType = pollConfig.eventType ?? 'poll';
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

  stop(): Promise<void> {
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

      const response = await fetch(this.url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
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
   * Check if an item should be pushed into the buffer (dedup check).
   * Returns true if the item is new (not previously seen).
   */
  private shouldPush(item: unknown): boolean {
    if (!this.deduplicateBy) return true;

    const record = item as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') return true;

    const idValue = record[this.deduplicateBy];
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
   * Returns `undefined` if no dedup field is configured or the field is absent.
   */
  private extractItemIdempotencyKey(item: unknown): string | undefined {
    if (!this.deduplicateBy) return undefined;

    const record = item as Record<string, unknown> | null;
    if (!record || typeof record !== 'object') return undefined;

    const idValue = record[this.deduplicateBy];
    if (idValue === undefined || idValue === null) return undefined;

    const id =
      typeof idValue === 'string' || typeof idValue === 'number' || typeof idValue === 'boolean'
        ? String(idValue)
        : JSON.stringify(idValue);

    return `poll:${this.connectionAlias}:${id}`;
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

registerIngestorFactory('poll', (connectionAlias, config, secrets, bufferSize) => {
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
  );
});
