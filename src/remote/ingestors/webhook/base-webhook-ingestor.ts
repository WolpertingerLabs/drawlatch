/**
 * Generic webhook ingestor base class.
 *
 * A passive ingestor that receives HTTP POST requests from webhook providers
 * and buffers them in the ring buffer for retrieval via `poll_events`.
 *
 * Unlike WebSocket ingestors (which maintain outbound connections), webhook
 * ingestors are receivers — the Express server dispatches incoming webhook
 * requests to matching ingestor instances via `handleWebhook()`.
 *
 * Subclasses implement service-specific signature verification and event
 * extraction by overriding `verifySignature()`, `extractEventType()`, and
 * `extractEventData()`.
 *
 * @see GitHubWebhookIngestor
 * @see StripeWebhookIngestor
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { WebhookIngestorConfig } from '../types.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook');

// ── Abstract Webhook Ingestor ──────────────────────────────────────────

export abstract class WebhookIngestor extends BaseIngestor {
  /** The path segment this ingestor listens on (e.g., 'github' → /webhooks/github). */
  readonly webhookPath: string;

  /** The name of the secret key in the resolved secrets used for signature verification. */
  protected readonly signatureSecretName: string | undefined;

  /** The header name containing the webhook signature. */
  protected readonly signatureHeader: string | undefined;

  /** Event type filter (empty = capture all). */
  protected readonly eventFilter: string[];

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    webhookConfig: WebhookIngestorConfig,
    bufferSize?: number,
  ) {
    super(connectionAlias, 'webhook', secrets, bufferSize);
    this.webhookPath = webhookConfig.path;
    this.signatureHeader = webhookConfig.signatureHeader;
    this.signatureSecretName = webhookConfig.signatureSecret;
    this.eventFilter = [];
  }

  /**
   * Start the webhook ingestor.
   *
   * Unlike WebSocket ingestors, there's nothing to "connect" to — the ingestor
   * is passive and waits for `handleWebhook()` calls from the Express route.
   * We set the state to 'connected' immediately.
   */
  start(): Promise<void> {
    this.state = 'connected';
    log.info(
      `Webhook ingestor ready for ${this.connectionAlias} ` +
        `(path: /webhooks/${this.webhookPath})`,
    );
    return Promise.resolve();
  }

  /**
   * Stop the webhook ingestor. Nothing to clean up — just set state.
   */
  stop(): Promise<void> {
    this.state = 'stopped';
    return Promise.resolve();
  }

  // ── Abstract methods for subclasses ───────────────────────────────────

  /**
   * Verify the webhook signature.
   *
   * Called before any body parsing. Subclasses implement service-specific
   * signature verification logic (e.g., HMAC-SHA256 for GitHub, timestamp
   * + HMAC for Stripe).
   *
   * @param headers - The raw HTTP request headers.
   * @param rawBody - The raw request body as a Buffer.
   * @returns An object with `valid: true` if verification passed or was skipped,
   *          or `valid: false` with a `reason` string if verification failed.
   */
  protected abstract verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { valid: boolean; reason?: string };

  /**
   * Extract the event type from the webhook request.
   *
   * Some providers encode the event type in a header (GitHub: `X-GitHub-Event`),
   * others in the JSON body (Stripe: `body.type`).
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns The event type string (e.g., 'push', 'payment_intent.succeeded').
   */
  protected abstract extractEventType(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string;

  /**
   * Extract the event data to push into the ring buffer.
   *
   * Subclasses determine the shape of the data stored for each event.
   * For example, GitHub stores `{ deliveryId, event, payload }` while
   * Stripe stores `{ eventId, type, payload }`.
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns The data object to store in the ring buffer.
   */
  protected abstract extractEventData(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): unknown;

  /**
   * Extract a service-specific idempotency key from the webhook request.
   *
   * Subclasses override this to return a unique key for deduplication
   * (e.g., GitHub's `X-GitHub-Delivery` header, Stripe's `body.id`).
   *
   * When a key is returned, duplicate events with the same key are silently
   * dropped by the base ingestor's ring buffer.
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns A unique idempotency key string, or `undefined` to use a fallback.
   */
  protected extractIdempotencyKey(
    _headers: Record<string, string | string[] | undefined>,
    _body: unknown,
  ): string | undefined {
    return undefined;
  }

  // ── Webhook handling ──────────────────────────────────────────────────

  /**
   * Handle an incoming webhook request.
   *
   * Called by the Express route handler when a POST arrives at
   * `/webhooks/:path` that matches this ingestor's `webhookPath`.
   *
   * Orchestrates the full pipeline: verify → parse → extract → filter → buffer.
   *
   * @param headers - The raw HTTP request headers.
   * @param rawBody - The raw request body as a Buffer (needed for signature verification).
   * @returns An object indicating whether the webhook was accepted or rejected.
   */
  handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { accepted: boolean; reason?: string } {
    log.debug(`${this.connectionAlias} received webhook (${rawBody.length} bytes)`);

    // 1. Signature verification (delegated to subclass)
    const verification = this.verifySignature(headers, rawBody);
    if (!verification.valid) {
      log.debug(`${this.connectionAlias} webhook rejected: ${verification.reason}`);
      return { accepted: false, reason: verification.reason };
    }

    // 2. Parse body
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return { accepted: false, reason: 'Invalid JSON body' };
    }

    // 3. Determine event type (delegated to subclass)
    const eventType = this.extractEventType(headers, body);

    // 4. Apply event filter (if any — reserved for future caller overrides)
    if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventType)) {
      return { accepted: true, reason: 'Filtered out' };
    }

    // 5. Extract event data (delegated to subclass)
    const data = this.extractEventData(headers, body);

    // 6. Extract idempotency key (delegated to subclass, fallback in pushEvent)
    const idempotencyKey = this.extractIdempotencyKey(headers, body);

    // 7. Push event into ring buffer (dedup handled by base class)
    log.debug(`${this.connectionAlias} dispatching webhook event: ${eventType}`);
    this.pushEvent(eventType, data, idempotencyKey);

    return { accepted: true };
  }
}
