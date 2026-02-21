/**
 * Abstract base class for all ingestor types.
 *
 * Provides common functionality: ring buffer management, event counting,
 * status reporting, and a standard interface for start/stop lifecycle.
 *
 * Subclasses implement `start()` and `stop()` for their specific protocol
 * (WebSocket, webhook listener, HTTP poller, etc.) and call `pushEvent()`
 * whenever they receive data from the external service.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { IngestedEvent, IngestorState, IngestorStatus } from './types.js';
import { RingBuffer } from './ring-buffer.js';
import { DEFAULT_BUFFER_SIZE } from './types.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('ingestor');

/** Maximum number of idempotency keys to track for deduplication.
 *  When exceeded, the oldest half is pruned. */
const MAX_SEEN_KEYS = 2000;

/**
 * Epoch-based event IDs that are monotonically increasing across server reboots.
 * Format: `bootEpochSeconds * 1_000_000 + counter`.
 *
 * Uses seconds (not milliseconds) so the product stays within Number.MAX_SAFE_INTEGER.
 * This prevents clients with a stale `after_id` cursor from missing events
 * after a reboot — new IDs will always be higher than pre-reboot IDs
 * (assuming <1M events per boot and >1s between boots).
 */
const BOOT_EPOCH = Math.floor(Date.now() / 1000);
const ID_MULTIPLIER = 1_000_000;

export abstract class BaseIngestor extends EventEmitter {
  protected state: IngestorState = 'stopped';
  protected buffer: RingBuffer<IngestedEvent>;
  protected counter = 0;
  protected lastEventAt: string | null = null;
  protected errorMessage?: string;

  /** Recently seen idempotency keys for deduplication. */
  private readonly seenKeys = new Set<string>();

  constructor(
    /** The connection alias (e.g., 'discord-bot'). */
    protected readonly connectionAlias: string,
    /** The ingestor type (for status reporting). */
    protected readonly ingestorType: 'websocket' | 'webhook' | 'poll',
    /** Resolved secrets for the parent connection. */
    protected readonly secrets: Record<string, string>,
    /** Buffer capacity (defaults to DEFAULT_BUFFER_SIZE). */
    bufferSize: number = DEFAULT_BUFFER_SIZE,
  ) {
    super();
    this.buffer = new RingBuffer<IngestedEvent>(bufferSize);
  }

  /** Start the ingestor (connect WebSocket, begin polling, etc.). */
  abstract start(): Promise<void>;

  /** Stop the ingestor cleanly (close connections, clear timers). */
  abstract stop(): Promise<void>;

  /**
   * Push a new event into the ring buffer.
   * Called by subclasses when they receive data from an external service.
   *
   * @param eventType  The event type/name (e.g., 'push', 'MESSAGE_CREATE').
   * @param data       The raw event payload from the external service.
   * @param idempotencyKey  Optional service-specific unique key for deduplication.
   *                        When provided, duplicate events with the same key are silently dropped.
   *                        When omitted, a fallback key is generated from `${source}:${uuid-v4}`.
   */
  protected pushEvent(eventType: string, data: unknown, idempotencyKey?: string): void {
    // When an explicit key is provided, reject duplicates
    if (idempotencyKey && this.seenKeys.has(idempotencyKey)) {
      log.debug(`${this.connectionAlias} duplicate event skipped (key: ${idempotencyKey})`);
      return;
    }

    const now = new Date();
    const id = BOOT_EPOCH * ID_MULTIPLIER + this.counter++;
    const key = idempotencyKey ?? `${this.connectionAlias}:${crypto.randomUUID()}`;

    const event: IngestedEvent = {
      id,
      idempotencyKey: key,
      receivedAt: now.toISOString(),
      receivedAtMs: now.getTime(),
      source: this.connectionAlias,
      eventType,
      data,
    };
    this.buffer.push(event);
    this.lastEventAt = event.receivedAt;

    // Track the key for future dedup checks
    this.seenKeys.add(key);
    if (this.seenKeys.size > MAX_SEEN_KEYS) {
      this.pruneSeenKeys();
    }

    log.info(`${this.connectionAlias} event #${event.id}: ${eventType}`);
    log.debug(`${this.connectionAlias} event #${event.id} payload:`, JSON.stringify(data, null, 2));
    this.emit('event', event);
  }

  /**
   * Prune the seen-keys set to prevent unbounded memory growth.
   * Removes the oldest half of entries (Set preserves insertion order).
   */
  private pruneSeenKeys(): void {
    const pruneCount = Math.floor(this.seenKeys.size / 2);
    let removed = 0;
    for (const key of this.seenKeys) {
      if (removed >= pruneCount) break;
      this.seenKeys.delete(key);
      removed++;
    }
  }

  /**
   * Retrieve events since a cursor.
   * @param afterId  Return events with id > afterId. Pass -1 (or omit) for all buffered events.
   */
  getEvents(afterId = -1): IngestedEvent[] {
    if (afterId < 0) return this.buffer.toArray();
    return this.buffer.since(afterId);
  }

  /** Return the current status of this ingestor. */
  getStatus(): IngestorStatus {
    return {
      connection: this.connectionAlias,
      type: this.ingestorType,
      state: this.state,
      bufferedEvents: this.buffer.size,
      totalEventsReceived: this.counter,
      lastEventAt: this.lastEventAt,
      ...(this.errorMessage && { error: this.errorMessage }),
    };
  }
}
