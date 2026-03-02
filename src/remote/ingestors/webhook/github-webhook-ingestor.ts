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
import type { WebhookIngestorConfig } from '../types.js';
import { WebhookIngestor } from './base-webhook-ingestor.js';
import { verifyGitHubSignature, extractGitHubHeaders } from './github-types.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook');

// ── GitHub Webhook Ingestor ──────────────────────────────────────────────

export class GitHubWebhookIngestor extends WebhookIngestor {
  /**
   * Repository filter for multi-instance support.
   * When set, only webhooks from these repositories (owner/repo format) are accepted.
   * Set via `_repoFilter` on the webhook config (injected by IngestorManager).
   */
  private readonly repoFilter: string[];

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    webhookConfig: WebhookIngestorConfig,
    bufferSize?: number,
    instanceId?: string,
  ) {
    super(connectionAlias, secrets, webhookConfig, bufferSize, instanceId);

    // Repo filter for multi-instance discrimination
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- injected by IngestorManager for multi-instance support
    this.repoFilter = ((webhookConfig as any)._repoFilter as string[] | undefined) ?? [];
  }

  /**
   * Filter webhooks by repository for multi-instance support.
   * When repoFilter is set, only events from those repos are accepted.
   * The repo is found in `body.repository.full_name` of GitHub webhook payloads.
   */
  protected shouldAcceptPayload(body: unknown): boolean {
    if (this.repoFilter.length === 0) return true;
    const payload = body as { repository?: { full_name?: string } };
    const repo = payload?.repository?.full_name;
    // Events without a repository (e.g., org-level events) pass through when no filter
    return repo ? this.repoFilter.includes(repo) : true;
  }

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
      log.error(
        `Signature secret "${this.signatureSecretName}" not found ` +
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
      log.warn(
        `Signature verification failed for ${this.connectionAlias} ` +
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

  /**
   * Extract the GitHub delivery ID as the idempotency key.
   *
   * Each webhook delivery from GitHub carries a unique `X-GitHub-Delivery`
   * UUID. Using this as the idempotency key prevents duplicate events
   * from webhook retries.
   */
  protected extractIdempotencyKey(
    headers: Record<string, string | string[] | undefined>,
    _body: unknown,
  ): string | undefined {
    const deliveryId = extractGitHubHeaders(headers).deliveryId;
    return deliveryId ? `github:${deliveryId}` : undefined;
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory('webhook:generic', (connectionAlias, config, secrets, bufferSize, instanceId) => {
  if (!config.webhook) {
    log.error(`Missing webhook config for ${connectionAlias}`);
    return null;
  }
  return new GitHubWebhookIngestor(connectionAlias, secrets, config.webhook, bufferSize, instanceId);
});
