/**
 * IngestorManager — owns and manages the lifecycle of all ingestor instances.
 *
 * Keyed by `callerAlias:connectionAlias:instanceId`, so each caller gets its
 * own ingestor instance (with its own secrets, buffer, and connection state).
 * Multiple sessions from the same caller share the same ingestor/buffer.
 *
 * Supports multi-instance listeners: when a caller defines `listenerInstances`
 * for a connection, one ingestor is spawned per instanceId (e.g., watching
 * multiple Trello boards or multiple Reddit subreddits simultaneously).
 *
 * The manager is created once when the remote server starts, and provides
 * event retrieval and status methods used by the `poll_events` and
 * `ingestor_status` tool handlers.
 */

import {
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  type IngestorOverrides,
  type RemoteServerConfig,
  type Route,
  type ResolvedRoute,
  type ListenerConfigField,
} from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('ingestor');
import type {
  IngestedEvent,
  IngestorConfig,
  IngestorStatus,
  WebSocketIngestorConfig,
} from './types.js';
import type { BaseIngestor } from './base-ingestor.js';
import { createIngestor } from './registry.js';
import { WebhookIngestor } from './webhook/base-webhook-ingestor.js';

// Import providers so they self-register their factories.
// Each provider calls registerIngestorFactory() at module load time.
import './discord/discord-gateway.js';
import './slack/socket-mode.js';
import './webhook/github-webhook-ingestor.js';
import './webhook/stripe-webhook-ingestor.js';
import './webhook/trello-webhook-ingestor.js';
import './poll/poll-ingestor.js';

// ── Key helpers ────────────────────────────────────────────────────────────

/** Sentinel instance ID used for single-instance (default) connections. */
const DEFAULT_INSTANCE_ID = '_default';

/** Build a composite ingestor map key. */
function makeKey(caller: string, connection: string, instance: string = DEFAULT_INSTANCE_ID): string {
  return `${caller}:${connection}:${instance}`;
}

/** Parse a composite ingestor map key. */
function parseKey(key: string): { caller: string; connection: string; instance: string } {
  const firstColon = key.indexOf(':');
  const secondColon = key.indexOf(':', firstColon + 1);
  return {
    caller: key.slice(0, firstColon),
    connection: key.slice(firstColon + 1, secondColon),
    instance: key.slice(secondColon + 1),
  };
}

// ── Result type ────────────────────────────────────────────────────────────

interface LifecycleResult {
  success: boolean;
  connection: string;
  instanceId?: string;
  state?: string;
  error?: string;
}

// ── Manager ────────────────────────────────────────────────────────────────

export class IngestorManager {
  /** Active ingestor instances, keyed by `callerAlias:connectionAlias:instanceId`. */
  private ingestors = new Map<string, BaseIngestor>();

  constructor(private readonly config: RemoteServerConfig) {}

  /**
   * Start ingestors for all callers whose connections have an `ingestor` config.
   * Called once when the remote server starts listening.
   *
   * For connections with `listenerInstances`, spawns one ingestor per instanceId.
   * For connections without, spawns a single default instance (backward compatible).
   */
  async startAll(): Promise<void> {
    for (const [callerAlias, callerConfig] of Object.entries(this.config.callers)) {
      // Resolve routes for this caller (raw + resolved)
      const rawRoutes = resolveCallerRoutes(this.config, callerAlias);
      const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});
      const resolvedRoutes = resolveRoutes(rawRoutes, callerEnvResolved);

      for (let i = 0; i < rawRoutes.length; i++) {
        const rawRoute = rawRoutes[i];
        const resolvedRoute = resolvedRoutes[i];
        const connectionAlias = callerConfig.connections[i];

        // Skip connections without an ingestor config
        if (!rawRoute.ingestor) continue;

        // Check if this connection has multi-instance definitions
        const instances = callerConfig.listenerInstances?.[connectionAlias];

        if (instances && Object.keys(instances).length > 0) {
          // Multi-instance: spawn one ingestor per instanceId
          for (const [instanceId, instanceOverrides] of Object.entries(instances)) {
            if (instanceOverrides.disabled) {
              log.info(`Skipping disabled instance ${callerAlias}:${connectionAlias}:${instanceId}`);
              continue;
            }

            const key = makeKey(callerAlias, connectionAlias, instanceId);
            if (this.ingestors.has(key)) continue;

            await this.startIngestor(
              key,
              connectionAlias,
              rawRoute,
              resolvedRoute,
              instanceOverrides,
              instanceId,
            );
          }
        } else {
          // Single-instance (backward compatible)
          const overrides = callerConfig.ingestorOverrides?.[connectionAlias];

          if (overrides?.disabled) {
            log.info(`Skipping disabled ingestor for ${callerAlias}:${connectionAlias}`);
            continue;
          }

          const key = makeKey(callerAlias, connectionAlias);
          if (this.ingestors.has(key)) continue;

          await this.startIngestor(
            key,
            connectionAlias,
            rawRoute,
            resolvedRoute,
            overrides,
            undefined,
          );
        }
      }
    }

    const count = this.ingestors.size;
    if (count > 0) {
      log.info(`${count} ingestor(s) started`);
    }
  }

  /**
   * Internal: create, register, and start a single ingestor instance.
   */
  private async startIngestor(
    key: string,
    connectionAlias: string,
    rawRoute: Route,
    resolvedRoute: ResolvedRoute,
    overrides: IngestorOverrides | undefined,
    instanceId: string | undefined,
  ): Promise<void> {
    // Merge caller overrides into a copy of the template config
    const effectiveConfig = IngestorManager.mergeIngestorConfig(rawRoute.ingestor!, overrides);

    // Apply instance params to config and secrets
    const instanceSecrets = { ...resolvedRoute.secrets };
    if (overrides?.params && rawRoute.listenerConfig) {
      IngestorManager.applyInstanceParams(
        effectiveConfig,
        instanceSecrets,
        overrides.params,
        rawRoute.listenerConfig.fields,
      );
    }

    // For poll ingestors, attach the resolved route headers so the factory
    // can pass them through for authenticated HTTP requests.
    if (effectiveConfig.type === 'poll') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- private property consumed by poll factory
      (effectiveConfig as any)._resolvedRouteHeaders = resolvedRoute.headers;
    }

    const ingestor = createIngestor(
      connectionAlias,
      effectiveConfig,
      instanceSecrets,
      overrides?.bufferSize,
      instanceId,
    );

    if (ingestor) {
      this.ingestors.set(key, ingestor);
      log.info(`Starting ${effectiveConfig.type} ingestor for ${key}`);
      try {
        await ingestor.start();
      } catch (err) {
        log.error(`Failed to start ${key}:`, err);
      }
    }
  }

  /**
   * Stop all running ingestors. Called during graceful shutdown.
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.ingestors.entries()).map(async ([key, ingestor]) => {
      log.info(`Stopping ${key}`);
      try {
        await ingestor.stop();
      } catch (err) {
        log.error(`Error stopping ${key}:`, err);
      }
    });
    await Promise.all(stops);
    this.ingestors.clear();
  }

  /**
   * Get events for a specific caller and connection, optionally filtered by instance.
   * When instanceId is omitted, aggregates events from all instances of that connection.
   */
  getEvents(callerAlias: string, connectionAlias: string, afterId = -1, instanceId?: string): IngestedEvent[] {
    if (instanceId) {
      // Specific instance
      const key = makeKey(callerAlias, connectionAlias, instanceId);
      const ingestor = this.ingestors.get(key);
      if (!ingestor) return [];
      return ingestor.getEvents(afterId);
    }

    // All instances of this connection (including _default)
    const prefix = `${callerAlias}:${connectionAlias}:`;
    const events: IngestedEvent[] = [];
    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        events.push(...ingestor.getEvents(afterId));
      }
    }
    events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    return events;
  }

  /**
   * Get events across all ingestors for a caller, sorted chronologically.
   * @param callerAlias  The caller whose events to retrieve.
   * @param afterId  Return events with id > afterId. Pass -1 for all.
   */
  getAllEvents(callerAlias: string, afterId = -1): IngestedEvent[] {
    const events: IngestedEvent[] = [];
    const prefix = `${callerAlias}:`;

    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        events.push(...ingestor.getEvents(afterId));
      }
    }

    // Sort by receivedAt (ISO strings sort lexicographically)
    events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    return events;
  }

  /**
   * Get status of all ingestors for a caller.
   */
  getStatuses(callerAlias: string): IngestorStatus[] {
    const statuses: IngestorStatus[] = [];
    const prefix = `${callerAlias}:`;

    for (const [key, ingestor] of this.ingestors) {
      if (key.startsWith(prefix)) {
        statuses.push(ingestor.getStatus());
      }
    }
    return statuses;
  }

  /**
   * Find all webhook ingestor instances that match a given webhook path.
   * Returns all matching instances across all callers (for fan-out dispatch).
   *
   * @param path - The webhook path segment (e.g., 'github' from /webhooks/github).
   */
  getWebhookIngestors(path: string): WebhookIngestor[] {
    const matches: WebhookIngestor[] = [];
    for (const ingestor of this.ingestors.values()) {
      if (ingestor instanceof WebhookIngestor && ingestor.webhookPath === path) {
        matches.push(ingestor);
      }
    }
    return matches;
  }

  // ── Runtime lifecycle control ──────────────────────────────────────────

  /**
   * Start a single ingestor for a specific caller+connection pair.
   * When instanceId is provided, starts that specific instance.
   * When omitted, starts the default instance (or all instances if listenerInstances is defined).
   */
  async startOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
  ): Promise<LifecycleResult | LifecycleResult[]> {
    const callerConfig = this.config.callers[callerAlias];
    if (!callerConfig) {
      return { success: false, connection: connectionAlias, error: `Unknown caller: ${callerAlias}` };
    }

    const connectionIndex = callerConfig.connections.indexOf(connectionAlias);
    if (connectionIndex === -1) {
      return { success: false, connection: connectionAlias, error: `Caller does not have connection: ${connectionAlias}` };
    }

    const rawRoutes = resolveCallerRoutes(this.config, callerAlias);
    const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});
    const resolvedRoutes = resolveRoutes(rawRoutes, callerEnvResolved);
    const rawRoute = rawRoutes[connectionIndex];
    const resolvedRoute = resolvedRoutes[connectionIndex];

    if (!rawRoute.ingestor) {
      return { success: false, connection: connectionAlias, error: 'This connection does not have an ingestor.' };
    }

    // If a specific instanceId is given, start just that one
    if (instanceId) {
      return this.startOneInstance(callerAlias, connectionAlias, instanceId, rawRoute, resolvedRoute);
    }

    // If listenerInstances is defined, start all instances
    const instances = callerConfig.listenerInstances?.[connectionAlias];
    if (instances && Object.keys(instances).length > 0) {
      const results: LifecycleResult[] = [];
      for (const [instId, instOverrides] of Object.entries(instances)) {
        if (instOverrides.disabled) continue;
        results.push(await this.startOneInstance(callerAlias, connectionAlias, instId, rawRoute, resolvedRoute));
      }
      return results;
    }

    // Single default instance
    return this.startOneInstance(callerAlias, connectionAlias, undefined, rawRoute, resolvedRoute);
  }

  /** Internal: start a single specific instance. */
  private async startOneInstance(
    callerAlias: string,
    connectionAlias: string,
    instanceId: string | undefined,
    rawRoute: Route,
    resolvedRoute: ResolvedRoute,
  ): Promise<LifecycleResult> {
    const key = makeKey(callerAlias, connectionAlias, instanceId ?? DEFAULT_INSTANCE_ID);

    // If already running, return current status
    const existing = this.ingestors.get(key);
    if (existing) {
      const status = existing.getStatus();
      if (status.state === 'connected' || status.state === 'starting' || status.state === 'reconnecting') {
        return { success: true, connection: connectionAlias, instanceId, state: status.state };
      }
      // Remove stopped instance to recreate
      this.ingestors.delete(key);
    }

    const callerConfig = this.config.callers[callerAlias];
    const overrides = instanceId
      ? callerConfig.listenerInstances?.[connectionAlias]?.[instanceId]
      : callerConfig.ingestorOverrides?.[connectionAlias];

    const effectiveConfig = IngestorManager.mergeIngestorConfig(rawRoute.ingestor!, overrides);

    // Apply instance params
    const instanceSecrets = { ...resolvedRoute.secrets };
    if (overrides?.params && rawRoute.listenerConfig) {
      IngestorManager.applyInstanceParams(
        effectiveConfig,
        instanceSecrets,
        overrides.params,
        rawRoute.listenerConfig.fields,
      );
    }

    if (effectiveConfig.type === 'poll') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (effectiveConfig as any)._resolvedRouteHeaders = resolvedRoute.headers;
    }

    const ingestor = createIngestor(
      connectionAlias,
      effectiveConfig,
      instanceSecrets,
      overrides?.bufferSize,
      instanceId,
    );

    if (!ingestor) {
      return { success: false, connection: connectionAlias, instanceId, error: 'Failed to create ingestor.' };
    }

    this.ingestors.set(key, ingestor);
    log.info(`Starting ${effectiveConfig.type} ingestor for ${key}`);

    try {
      await ingestor.start();
      return { success: true, connection: connectionAlias, instanceId, state: ingestor.getStatus().state };
    } catch (err) {
      log.error(`Failed to start ${key}:`, err);
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Stop a single ingestor for a specific caller+connection pair.
   * When instanceId is provided, stops that specific instance.
   * When omitted, stops all instances of that connection.
   */
  async stopOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
  ): Promise<LifecycleResult | LifecycleResult[]> {
    if (instanceId) {
      return this.stopOneInstance(callerAlias, connectionAlias, instanceId);
    }

    // Stop all instances for this connection
    const prefix = `${callerAlias}:${connectionAlias}:`;
    const keysToStop = Array.from(this.ingestors.keys()).filter(k => k.startsWith(prefix));

    if (keysToStop.length === 0) {
      return { success: false, connection: connectionAlias, error: 'No ingestor running for this connection.' };
    }

    if (keysToStop.length === 1) {
      const parsed = parseKey(keysToStop[0]);
      const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
      return this.stopOneInstance(callerAlias, connectionAlias, instId);
    }

    const results: LifecycleResult[] = [];
    for (const key of keysToStop) {
      const parsed = parseKey(key);
      const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
      results.push(await this.stopOneInstance(callerAlias, connectionAlias, instId));
    }
    return results;
  }

  /** Internal: stop a single specific instance. */
  private async stopOneInstance(
    callerAlias: string,
    connectionAlias: string,
    instanceId: string | undefined,
  ): Promise<LifecycleResult> {
    const key = makeKey(callerAlias, connectionAlias, instanceId ?? DEFAULT_INSTANCE_ID);
    const ingestor = this.ingestors.get(key);

    if (!ingestor) {
      return { success: false, connection: connectionAlias, instanceId, error: 'No ingestor running for this connection.' };
    }

    log.info(`Stopping ${key}`);
    try {
      await ingestor.stop();
      this.ingestors.delete(key);
      return { success: true, connection: connectionAlias, instanceId, state: 'stopped' };
    } catch (err) {
      log.error(`Error stopping ${key}:`, err);
      return {
        success: false,
        connection: connectionAlias,
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Restart a single ingestor (stop + start). Useful after configuration changes.
   */
  async restartOne(
    callerAlias: string,
    connectionAlias: string,
    instanceId?: string,
  ): Promise<LifecycleResult | LifecycleResult[]> {
    // Stop all matching instances
    const prefix = instanceId
      ? makeKey(callerAlias, connectionAlias, instanceId)
      : `${callerAlias}:${connectionAlias}:`;

    for (const key of Array.from(this.ingestors.keys())) {
      if (instanceId ? key === prefix : key.startsWith(prefix)) {
        const parsed = parseKey(key);
        const instId = parsed.instance === DEFAULT_INSTANCE_ID ? undefined : parsed.instance;
        await this.stopOneInstance(callerAlias, connectionAlias, instId);
      }
    }

    // Start fresh
    return this.startOne(callerAlias, connectionAlias, instanceId);
  }

  /**
   * Check if an ingestor exists (running or otherwise) for a caller+connection pair.
   * When instanceId is provided, checks that specific instance.
   * When omitted, checks if any instance exists for that connection.
   */
  has(callerAlias: string, connectionAlias: string, instanceId?: string): boolean {
    if (instanceId) {
      return this.ingestors.has(makeKey(callerAlias, connectionAlias, instanceId));
    }
    const prefix = `${callerAlias}:${connectionAlias}:`;
    for (const key of this.ingestors.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Merge caller-level ingestor overrides into a copy of the template config.
   * Override fields replace template values; omitted fields inherit the template defaults.
   */
  static mergeIngestorConfig(
    templateConfig: IngestorConfig,
    overrides?: IngestorOverrides,
  ): IngestorConfig {
    if (!overrides) return templateConfig;

    // Deep-copy to avoid mutating the shared template
    const merged: IngestorConfig = {
      type: templateConfig.type,
      ...(templateConfig.websocket && {
        websocket: { ...templateConfig.websocket },
      }),
      ...(templateConfig.webhook && {
        webhook: { ...templateConfig.webhook },
      }),
      ...(templateConfig.poll && {
        poll: { ...templateConfig.poll },
      }),
    };

    // Apply WebSocket-specific overrides
    if (merged.websocket) {
      const ws: WebSocketIngestorConfig = merged.websocket;
      if (overrides.intents !== undefined) ws.intents = overrides.intents;
      if (overrides.eventFilter !== undefined) ws.eventFilter = overrides.eventFilter;
      if (overrides.guildIds !== undefined) ws.guildIds = overrides.guildIds;
      if (overrides.channelIds !== undefined) ws.channelIds = overrides.channelIds;
      if (overrides.userIds !== undefined) ws.userIds = overrides.userIds;
    }

    // Apply poll-specific overrides
    if (merged.poll) {
      if (overrides.intervalMs !== undefined) merged.poll.intervalMs = overrides.intervalMs;
    }

    return merged;
  }

  /**
   * Apply instance-specific params from IngestorOverrides to the effective config and secrets.
   *
   * For each param, checks the connection's listenerConfig fields:
   *   - If the field has `overrideKey`, injects `params[key]` as `secrets[overrideKey]`
   *     (used by poll ingestors for URL template resolution, e.g., REDDIT_SUBREDDIT).
   *   - If the field has `instanceKey` and the config is a webhook, attaches
   *     the value to the webhook config for payload discrimination (e.g., _boardId for Trello).
   *   - Otherwise, attaches the value as a generic `_instanceParams` bag on the config.
   */
  static applyInstanceParams(
    config: IngestorConfig,
    secrets: Record<string, string>,
    params: Record<string, unknown>,
    fields: ListenerConfigField[],
  ): void {
    const fieldsByKey = new Map(fields.map(f => [f.key, f]));

    for (const [paramKey, paramValue] of Object.entries(params)) {
      const field = fieldsByKey.get(paramKey);
      if (!field) continue;

      // overrideKey: inject as a secret for ${VAR} placeholder resolution
      if (field.overrideKey && typeof paramValue === 'string') {
        secrets[field.overrideKey] = paramValue;
      }

      // instanceKey on webhook config: attach for payload discrimination
      if (field.instanceKey && config.webhook) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        (config.webhook as any)[`_${paramKey}`] = paramValue;
      }
    }
  }
}

// Export key helpers for testing
export { makeKey, parseKey, DEFAULT_INSTANCE_ID };
