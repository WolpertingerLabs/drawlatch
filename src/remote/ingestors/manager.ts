/**
 * IngestorManager — owns and manages the lifecycle of all ingestor instances.
 *
 * Keyed by `callerAlias:connectionAlias`, so each caller gets its own
 * ingestor instance (with its own secrets, buffer, and connection state).
 * Multiple sessions from the same caller share the same ingestor/buffer.
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
} from '../../shared/config.js';
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

export class IngestorManager {
  /** Active ingestor instances, keyed by `callerAlias:connectionAlias`. */
  private ingestors = new Map<string, BaseIngestor>();

  constructor(private readonly config: RemoteServerConfig) {}

  /**
   * Start ingestors for all callers whose connections have an `ingestor` config.
   * Called once when the remote server starts listening.
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

        // Get caller-level overrides for this connection
        const overrides = callerConfig.ingestorOverrides?.[connectionAlias];

        // Skip if explicitly disabled by caller
        if (overrides?.disabled) {
          console.log(
            `[ingestor] Skipping disabled ingestor for ${callerAlias}:${connectionAlias}`,
          );
          continue;
        }

        const key = `${callerAlias}:${connectionAlias}`;
        if (this.ingestors.has(key)) continue;

        // Merge caller overrides into a copy of the template config
        const effectiveConfig = IngestorManager.mergeIngestorConfig(rawRoute.ingestor, overrides);

        const ingestor = createIngestor(
          connectionAlias,
          effectiveConfig,
          resolvedRoute.secrets,
          overrides?.bufferSize,
        );

        if (ingestor) {
          this.ingestors.set(key, ingestor);
          console.log(`[ingestor] Starting ${effectiveConfig.type} ingestor for ${key}`);
          try {
            await ingestor.start();
          } catch (err) {
            console.error(`[ingestor] Failed to start ${key}:`, err);
          }
        }
      }
    }

    const count = this.ingestors.size;
    if (count > 0) {
      console.log(`[ingestor] ${count} ingestor(s) started`);
    }
  }

  /**
   * Stop all running ingestors. Called during graceful shutdown.
   */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.ingestors.entries()).map(async ([key, ingestor]) => {
      console.log(`[ingestor] Stopping ${key}`);
      try {
        await ingestor.stop();
      } catch (err) {
        console.error(`[ingestor] Error stopping ${key}:`, err);
      }
    });
    await Promise.all(stops);
    this.ingestors.clear();
  }

  /**
   * Get events for a specific caller and connection.
   * @param callerAlias  The caller whose events to retrieve.
   * @param connectionAlias  The connection to filter by.
   * @param afterId  Return events with id > afterId. Pass -1 for all.
   */
  getEvents(callerAlias: string, connectionAlias: string, afterId = -1): IngestedEvent[] {
    const key = `${callerAlias}:${connectionAlias}`;
    const ingestor = this.ingestors.get(key);
    if (!ingestor) return [];
    return ingestor.getEvents(afterId);
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

    return merged;
  }
}
