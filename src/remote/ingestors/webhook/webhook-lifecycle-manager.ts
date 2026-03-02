/**
 * Webhook Lifecycle Manager.
 *
 * Stateless utility that executes declarative lifecycle HTTP requests to
 * list, register, and unregister webhooks with external services.
 *
 * Used by webhook ingestors with a `lifecycle` config block to auto-register
 * webhooks on start, clean up stale registrations (e.g., after tunnel URL changes),
 * and unregister on permanent shutdown or instance deletion.
 *
 * All HTTP requests use native `fetch()` directly (not proxy routes) since
 * secrets are already resolved and lifecycle URLs may not match the
 * connection's `allowedEndpoints` patterns.
 */

import type { WebhookLifecycleConfig, WebhookRegistrationState } from './lifecycle-types.js';
import { resolvePlaceholders } from '../../../shared/config.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook-lifecycle');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Recursively resolve `${VAR}` placeholders in an object tree.
 * Walks objects and arrays, resolving placeholders in all string values.
 */
function resolveDeep(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return resolvePlaceholders(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveDeep(item, secrets));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveDeep(v, secrets);
    }
    return result;
  }
  return value;
}

/**
 * Extract a value from a nested object using a dot-separated path.
 * E.g., `getByPath(obj, 'data.webhooks')` → `obj.data.webhooks`.
 */
function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── Lifecycle Manager ────────────────────────────────────────────────────

export class WebhookLifecycleManager {
  private readonly config: WebhookLifecycleConfig;
  private readonly secrets: Record<string, string>;

  constructor(config: WebhookLifecycleConfig, secrets: Record<string, string>) {
    this.config = config;
    this.secrets = secrets;
  }

  /**
   * Ensure a webhook is registered with the external service (idempotent).
   *
   * Flow:
   * 1. If `list` config exists → fetch existing webhooks, find one matching
   *    callbackUrl (+ modelId if provided) → reuse if found
   * 2. Find stale webhooks (matching modelId but wrong callbackUrl) → unregister each
   * 3. If no match → call `register` to create a new webhook
   *
   * Graceful degradation: if `list` fails, attempts direct `register`.
   * All errors are caught and returned in the state object.
   */
  async ensureRegistered(
    callbackUrl: string,
    modelId?: string,
  ): Promise<WebhookRegistrationState> {
    const now = new Date().toISOString();

    try {
      // Try to discover existing webhooks
      let existingWebhooks: Array<Record<string, unknown>> | null = null;

      if (this.config.list) {
        try {
          existingWebhooks = await this.listWebhooks();
        } catch (err) {
          log.warn('Failed to list existing webhooks, attempting direct registration:', err);
          // Fall through to register
        }
      }

      if (existingWebhooks !== null && this.config.list) {
        const listConfig = this.config.list;

        // Find a webhook matching our callback URL (and model ID if applicable)
        const matching = existingWebhooks.find(wh => {
          const whCallbackUrl = String(wh[listConfig.callbackUrlField] ?? '');
          const urlMatch = whCallbackUrl === callbackUrl;

          if (!urlMatch) return false;
          if (modelId && listConfig.modelIdField) {
            return String(wh[listConfig.modelIdField] ?? '') === modelId;
          }
          return true;
        });

        if (matching) {
          const webhookId = String(matching[listConfig.idField]);
          log.info(`Found existing webhook (ID: ${webhookId}), reusing`);
          return { registered: true, webhookId, lastAttempt: now };
        }

        // Clean up stale webhooks (matching model but wrong callback URL)
        if (modelId && listConfig.modelIdField && this.config.unregister) {
          const stale = existingWebhooks.filter(wh => {
            const whModelId = String(wh[listConfig.modelIdField!] ?? '');
            const whCallbackUrl = String(wh[listConfig.callbackUrlField] ?? '');
            return whModelId === modelId && whCallbackUrl !== callbackUrl;
          });

          for (const staleWh of stale) {
            const staleId = String(staleWh[listConfig.idField]);
            log.info(`Cleaning up stale webhook (ID: ${staleId})`);
            try {
              await this.unregister(staleId);
            } catch (err) {
              log.warn(`Failed to clean up stale webhook ${staleId}:`, err);
            }
          }
        }
      }

      // No existing match — register a new webhook
      if (this.config.register) {
        return await this.register(callbackUrl, modelId);
      }

      // No register config — can't auto-register
      return { registered: false, error: 'No register config defined', lastAttempt: now };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error('Webhook lifecycle error:', error);
      return { registered: false, error, lastAttempt: now };
    }
  }

  /**
   * Unregister a webhook by ID.
   * Replaces `${_webhookId}` in the unregister URL with the given ID.
   * Errors are logged but never thrown.
   */
  async unregister(webhookId: string): Promise<void> {
    if (!this.config.unregister) {
      log.warn('No unregister config defined, skipping');
      return;
    }

    const mergedSecrets = { ...this.secrets, _webhookId: webhookId };
    const url = resolvePlaceholders(this.config.unregister.url, mergedSecrets);
    const headers = this.resolveHeaders(this.config.unregister.headers, mergedSecrets);

    try {
      const resp = await fetch(url, {
        method: this.config.unregister.method,
        headers,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        log.warn(`Webhook unregister failed (${resp.status}): ${body}`);
      } else {
        log.info(`Webhook unregistered (ID: ${webhookId})`);
      }
    } catch (err) {
      log.warn(`Webhook unregister request failed for ${webhookId}:`, err);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Fetch the list of existing webhooks from the external service. */
  private async listWebhooks(): Promise<Array<Record<string, unknown>>> {
    const listConfig = this.config.list!;
    const url = resolvePlaceholders(listConfig.url, this.secrets);
    const headers = this.resolveHeaders(listConfig.headers);

    const resp = await fetch(url, {
      method: listConfig.method,
      headers,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`List webhooks failed (${resp.status}): ${body}`);
    }

    const json = await resp.json();

    // Extract array from response (may be nested under a dot-path)
    let webhooks: unknown;
    if (listConfig.responsePath) {
      webhooks = getByPath(json, listConfig.responsePath);
    } else {
      webhooks = json;
    }

    if (!Array.isArray(webhooks)) {
      throw new Error(
        `Expected array from list endpoint${listConfig.responsePath ? ` at path "${listConfig.responsePath}"` : ''}, got ${typeof webhooks}`,
      );
    }

    return webhooks as Array<Record<string, unknown>>;
  }

  /** Register a new webhook with the external service. */
  private async register(
    callbackUrl: string,
    modelId?: string,
  ): Promise<WebhookRegistrationState> {
    const now = new Date().toISOString();
    const registerConfig = this.config.register!;

    // Merge callbackUrl and modelId into resolution context
    const mergedSecrets: Record<string, string> = { ...this.secrets };
    if (callbackUrl) mergedSecrets['CALLBACK_URL'] = callbackUrl;
    if (modelId) mergedSecrets['MODEL_ID'] = modelId;

    const url = resolvePlaceholders(registerConfig.url, mergedSecrets);
    const headers = this.resolveHeaders(registerConfig.headers, mergedSecrets);

    const fetchOptions: RequestInit = {
      method: registerConfig.method,
      headers,
    };

    if (registerConfig.body) {
      const resolvedBody = resolveDeep(registerConfig.body, mergedSecrets);
      fetchOptions.body = JSON.stringify(resolvedBody);
      // Ensure Content-Type is set if there's a body
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const resp = await fetch(url, fetchOptions);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        registered: false,
        error: `Register failed (${resp.status}): ${body}`,
        lastAttempt: now,
      };
    }

    const json = await resp.json();
    const webhookId = String(
      (json as Record<string, unknown>)[registerConfig.idField] ?? '',
    );

    if (!webhookId) {
      return {
        registered: false,
        error: `Register response missing "${registerConfig.idField}" field`,
        lastAttempt: now,
      };
    }

    log.info(`Webhook registered (ID: ${webhookId})`);
    return { registered: true, webhookId, lastAttempt: now };
  }

  /** Resolve headers with placeholder substitution. */
  private resolveHeaders(
    headers?: Record<string, string>,
    secretsOverride?: Record<string, string>,
  ): Record<string, string> {
    if (!headers) return {};
    const secrets = secretsOverride ?? this.secrets;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] = resolvePlaceholders(value, secrets);
    }
    return resolved;
  }
}
