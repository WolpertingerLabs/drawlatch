/**
 * GitHub Webhook ingestor.
 *
 * A passive ingestor that receives HTTP POST requests from GitHub webhooks
 * and buffers them in the ring buffer for retrieval via `poll_events`.
 *
 * Unlike WebSocket ingestors (which maintain outbound connections), the webhook
 * ingestor is a receiver — the Express server dispatches incoming webhook
 * requests to matching ingestor instances via `handleWebhook()`.
 *
 * Supports optional HMAC-SHA256 signature verification via the
 * `signatureHeader` and `signatureSecret` configuration fields.
 * If both are configured, incoming webhooks are verified; if either is
 * absent, verification is skipped entirely.
 *
 * @see https://docs.github.com/en/webhooks
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { WebhookIngestorConfig } from '../types.js';
import { registerIngestorFactory } from '../registry.js';
import { verifyGitHubSignature, extractGitHubHeaders } from './types.js';

// ── GitHub Webhook Ingestor ──────────────────────────────────────────────

export class GitHubWebhookIngestor extends BaseIngestor {
  /** The path segment this ingestor listens on (e.g., 'github' → /webhooks/github). */
  readonly webhookPath: string;

  /** The name of the secret key in the resolved secrets used for signature verification. */
  private readonly signatureSecretName: string | undefined;

  /** The header name containing the webhook signature. */
  private readonly signatureHeader: string | undefined;

  /** Event type filter (empty = capture all). */
  private readonly eventFilter: string[];

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    private readonly webhookConfig: WebhookIngestorConfig,
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
    console.log(
      `[webhook] GitHub webhook ingestor ready for ${this.connectionAlias} ` +
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

  /**
   * Handle an incoming webhook request.
   *
   * Called by the Express route handler when a POST arrives at
   * `/webhooks/:path` that matches this ingestor's `webhookPath`.
   *
   * @param headers - The raw HTTP request headers.
   * @param rawBody - The raw request body as a Buffer (needed for signature verification).
   * @returns An object indicating whether the webhook was accepted or rejected.
   */
  handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { accepted: boolean; reason?: string } {
    // 1. Extract GitHub-specific headers
    const ghHeaders = extractGitHubHeaders(headers);

    // 2. Signature verification (if configured)
    if (this.signatureSecretName && this.signatureHeader) {
      const secret = this.secrets[this.signatureSecretName];
      if (!secret) {
        console.error(
          `[webhook] Signature secret "${this.signatureSecretName}" not found ` +
            `in resolved secrets for ${this.connectionAlias}`,
        );
        return { accepted: false, reason: 'Signature secret not configured' };
      }

      const signature = ghHeaders.signature;
      if (!signature) {
        return { accepted: false, reason: 'Missing signature header' };
      }

      if (!verifyGitHubSignature(rawBody, signature, secret)) {
        console.warn(
          `[webhook] Signature verification failed for ${this.connectionAlias} ` +
            `(delivery: ${ghHeaders.deliveryId ?? 'unknown'})`,
        );
        return { accepted: false, reason: 'Signature verification failed' };
      }
    }

    // 3. Parse body
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return { accepted: false, reason: 'Invalid JSON body' };
    }

    // 4. Determine event type
    const eventType = ghHeaders.event;

    // 5. Apply event filter (if any — reserved for future caller overrides)
    if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventType)) {
      return { accepted: true, reason: 'Filtered out' };
    }

    // 6. Push event into ring buffer
    this.pushEvent(eventType, {
      deliveryId: ghHeaders.deliveryId,
      event: eventType,
      payload,
    });

    return { accepted: true };
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory('webhook', (connectionAlias, config, secrets, bufferSize) => {
  if (!config.webhook) {
    console.error(`[ingestor] Missing webhook config for ${connectionAlias}`);
    return null;
  }
  return new GitHubWebhookIngestor(connectionAlias, secrets, config.webhook, bufferSize);
});
