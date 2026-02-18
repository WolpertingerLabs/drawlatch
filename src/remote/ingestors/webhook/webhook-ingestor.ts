/**
 * GitHub Webhook ingestor.
 *
 * A concrete webhook ingestor that handles GitHub webhook events with optional
 * HMAC-SHA256 signature verification.
 *
 * Extends the generic `WebhookIngestor` base class, implementing GitHub-specific
 * signature verification (via `X-Hub-Signature-256`), event type extraction
 * (via `X-GitHub-Event` header), and data shaping.
 *
 * @see https://docs.github.com/en/webhooks
 */

import { registerIngestorFactory } from '../registry.js';
import { WebhookIngestor } from './base-webhook-ingestor.js';
import { verifyGitHubSignature, extractGitHubHeaders } from './types.js';

// ── GitHub Webhook Ingestor ──────────────────────────────────────────────

export class GitHubWebhookIngestor extends WebhookIngestor {
  /**
   * Verify the GitHub webhook signature (HMAC-SHA256).
   *
   * If both `signatureHeader` and `signatureSecretName` are configured,
   * the signature is verified. If either is absent, verification is skipped.
   */
  protected verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { valid: boolean; reason?: string } {
    if (!this.signatureSecretName || !this.signatureHeader) {
      return { valid: true };
    }

    const secret = this.secrets[this.signatureSecretName];
    if (!secret) {
      console.error(
        `[webhook] Signature secret "${this.signatureSecretName}" not found ` +
          `in resolved secrets for ${this.connectionAlias}`,
      );
      return { valid: false, reason: 'Signature secret not configured' };
    }

    const ghHeaders = extractGitHubHeaders(headers);
    const signature = ghHeaders.signature;
    if (!signature) {
      return { valid: false, reason: 'Missing signature header' };
    }

    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.warn(
        `[webhook] Signature verification failed for ${this.connectionAlias} ` +
          `(delivery: ${ghHeaders.deliveryId ?? 'unknown'})`,
      );
      return { valid: false, reason: 'Signature verification failed' };
    }

    return { valid: true };
  }

  /**
   * Extract the event type from the `X-GitHub-Event` header.
   */
  protected extractEventType(
    headers: Record<string, string | string[] | undefined>,
    _body: unknown,
  ): string {
    return extractGitHubHeaders(headers).event;
  }

  /**
   * Extract event data in the GitHub-specific shape:
   * `{ deliveryId, event, payload }`.
   */
  protected extractEventData(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): unknown {
    const ghHeaders = extractGitHubHeaders(headers);
    return {
      deliveryId: ghHeaders.deliveryId,
      event: ghHeaders.event,
      payload: body,
    };
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory('webhook:generic', (connectionAlias, config, secrets, bufferSize) => {
  if (!config.webhook) {
    console.error(`[ingestor] Missing webhook config for ${connectionAlias}`);
    return null;
  }
  return new GitHubWebhookIngestor(connectionAlias, secrets, config.webhook, bufferSize);
});
