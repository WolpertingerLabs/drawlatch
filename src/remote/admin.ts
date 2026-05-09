/**
 * Loopback-only, read-only admin HTTP API for the drawlatch-ui dashboard.
 *
 * SECURITY non-negotiables (mirrored in /admin.test.ts):
 *   - Never serializes Session.channel (AES keys) or ResolvedRoute.secrets.
 *   - Never returns process.env values; only key names. Secret presence is
 *     reported via `isSecretSetForCaller()` (booleans only).
 *   - Caller `env` mappings (e.g. "GITHUB_TOKEN": "${ACME_GITHUB_TOKEN}") are
 *     reduced to key-name lists — the value strings are NOT returned.
 *   - No mutations: every endpoint is GET.
 *   - No CORS. Loopback IS the trust boundary; the UI's local backend proxies.
 */

import express from 'express';
import fs from 'node:fs';

import {
  getCallerKeysDir,
  getServerKeysDir,
  getEnvFilePath,
  getRemoteConfigPath,
  loadRemoteConfig,
  type RemoteServerConfig,
} from '../shared/config.js';
import { listConnectionTemplates } from '../shared/connections.js';
import { isSecretSetForCaller } from '../shared/env-utils.js';
import { callerFingerprint } from '../shared/crypto/key-manager.js';
import type { IngestorManager } from './ingestors/index.js';
import type { IngestorStatus } from './ingestors/types.js';
import type { SessionSnapshot } from './server.js';
import path from 'node:path';

export interface AdminRouterDeps {
  /** Sanitized session snapshot — see Session in server.ts. */
  getSessionsSnapshot: () => SessionSnapshot[];
  /** Late-bound so tests can swap the manager without rebuilding the router. */
  ingestorManager: () => IngestorManager;
  /** Late-bound so changes to disk config are picked up between requests. */
  loadConfig: () => RemoteServerConfig;
  version: string;
  port: number;
  startedAt: number;
}

export function createAdminRouter(deps: AdminRouterDeps): express.Router {
  const router = express.Router();

  // ── /admin/meta ────────────────────────────────────────────────────────
  router.get('/meta', (_req, res) => {
    res.json({
      version: deps.version,
      port: deps.port,
      pid: process.pid,
      startedAt: deps.startedAt,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
      configPath: getRemoteConfigPath(),
      callerKeysDir: getCallerKeysDir(),
      serverKeysDir: getServerKeysDir(),
      envFilePath: getEnvFilePath(),
    });
  });

  // ── /admin/health ──────────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const statuses = deps.ingestorManager().getAllStatuses();
    const counts = { connected: 0, error: 0, starting: 0, stopped: 0 };
    for (const s of statuses) {
      if (s.state === 'connected') counts.connected++;
      else if (s.state === 'error') counts.error++;
      else if (s.state === 'starting' || s.state === 'reconnecting') counts.starting++;
      else counts.stopped++;
    }
    res.json({
      status: 'ok',
      activeSessions: deps.getSessionsSnapshot().length,
      ingestorCounts: counts,
      uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
    });
  });

  // ── /admin/callers ─────────────────────────────────────────────────────
  // Returns caller config metadata only — env values are reduced to key names.
  router.get('/callers', (_req, res) => {
    const config = deps.loadConfig();
    const callersKeysDir = getCallerKeysDir();
    const out = Object.entries(config.callers).map(([alias, caller]) => {
      const keysDirExists = fs.existsSync(path.join(callersKeysDir, alias));
      let fingerprint: string | null = null;
      try {
        fingerprint = keysDirExists ? callerFingerprint(alias) : null;
      } catch {
        fingerprint = null;
      }
      return {
        alias,
        name: caller.name ?? null,
        connections: caller.connections,
        // Key names ONLY — never the mapping value strings.
        envKeys: Object.keys(caller.env ?? {}),
        fingerprint,
        keysDirExists,
      };
    });
    res.json(out);
  });

  // ── /admin/connections ─────────────────────────────────────────────────
  // listConnectionTemplates already returns names-only — safe as-is.
  router.get('/connections', (_req, res) => {
    res.json(listConnectionTemplates());
  });

  // ── /admin/callers/:alias/connections ──────────────────────────────────
  router.get('/callers/:alias/connections', (req, res) => {
    const config = deps.loadConfig();
    if (!(req.params.alias in config.callers)) {
      res.status(404).json({ error: `Unknown caller: ${req.params.alias}` });
      return;
    }
    const caller = config.callers[req.params.alias];

    const templates = listConnectionTemplates();
    const tplMap = new Map(templates.map((t) => [t.alias, t]));
    const customMap = new Map((config.connectors ?? []).map((c) => [c.alias, c]));

    const out = caller.connections.map((connectionAlias) => {
      const tpl = tplMap.get(connectionAlias);
      const isCustom = !tpl;
      const requiredNames = tpl?.requiredSecrets ?? [];
      const optionalNames = tpl?.optionalSecrets ?? [];

      const requiredSecrets = requiredNames.map((name) => ({
        name,
        present: isSecretSetForCaller(name, req.params.alias, caller.env),
      }));
      const optionalSecrets = optionalNames.map((name) => ({
        name,
        present: isSecretSetForCaller(name, req.params.alias, caller.env),
      }));

      // Multi-instance projection — drop anything that could carry secrets.
      const instancesMap = caller.listenerInstances?.[connectionAlias] ?? {};
      const instances = Object.entries(instancesMap).map(([instanceId, ov]) => ({
        instanceId,
        params: {
          ...(ov.intents !== undefined && { intents: ov.intents }),
          ...(ov.eventFilter !== undefined && { eventFilter: ov.eventFilter }),
          ...(ov.guildIds !== undefined && { guildIds: ov.guildIds }),
          ...(ov.channelIds !== undefined && { channelIds: ov.channelIds }),
          ...(ov.userIds !== undefined && { userIds: ov.userIds }),
          ...(ov.bufferSize !== undefined && { bufferSize: ov.bufferSize }),
          ...(ov.intervalMs !== undefined && { intervalMs: ov.intervalMs }),
          ...(ov.disabled !== undefined && { disabled: ov.disabled }),
          // Listener params (board IDs, subreddit names, etc.) are user-set
          // configuration, not secrets. Pass through verbatim.
          ...(ov.params !== undefined && { ...ov.params }),
        },
      }));

      // `enabled`: a connection is enabled by default; explicit disabled
      // override (single-instance) toggles it off.
      const overrideDisabled = caller.ingestorOverrides?.[connectionAlias]?.disabled === true;

      return {
        connectionAlias,
        enabled: !overrideDisabled,
        isCustom,
        requiredSecrets,
        optionalSecrets,
        hasIngestor: tpl?.hasIngestor ?? customMap.get(connectionAlias)?.ingestor !== undefined,
        instances,
      };
    });

    res.json(out);
  });

  // ── /admin/ingestors ───────────────────────────────────────────────────
  router.get('/ingestors', (_req, res) => {
    const statuses = deps.ingestorManager().getAllStatuses();
    // getAllStatuses already augments with callerAlias; connection and
    // instanceId come from base IngestorStatus.
    const out = statuses.map((s: IngestorStatus & { callerAlias: string }) => ({
      callerAlias: s.callerAlias,
      connection: s.connection,
      ...(s.instanceId !== undefined && { instanceId: s.instanceId }),
      type: s.type,
      state: s.state,
      bufferedEvents: s.bufferedEvents,
      totalEventsReceived: s.totalEventsReceived,
      lastEventAt: s.lastEventAt,
      ...(s.error !== undefined && { error: s.error }),
      ...(s.webhookRegistration !== undefined && {
        webhookRegistration: s.webhookRegistration,
      }),
    }));
    res.json(out);
  });

  // ── /admin/sessions ────────────────────────────────────────────────────
  // SessionSnapshot already strips channel + resolvedRoutes — pass it through.
  router.get('/sessions', (_req, res) => {
    res.json(deps.getSessionsSnapshot());
  });

  // ── /admin/secrets ─────────────────────────────────────────────────────
  // Flat join of (caller × connection × secret), with `present` computed via
  // isSecretSetForCaller() — never the actual env value.
  router.get('/secrets', (_req, res) => {
    const config = deps.loadConfig();
    const tplMap = new Map(listConnectionTemplates().map((t) => [t.alias, t]));
    const out: {
      callerAlias: string;
      connection: string;
      name: string;
      required: boolean;
      present: boolean;
    }[] = [];

    for (const [callerAlias, caller] of Object.entries(config.callers)) {
      for (const connectionAlias of caller.connections) {
        const tpl = tplMap.get(connectionAlias);
        if (!tpl) continue; // custom connector — no template-defined secrets to enumerate
        for (const name of tpl.requiredSecrets) {
          out.push({
            callerAlias,
            connection: connectionAlias,
            name,
            required: true,
            present: isSecretSetForCaller(name, callerAlias, caller.env),
          });
        }
        for (const name of tpl.optionalSecrets) {
          out.push({
            callerAlias,
            connection: connectionAlias,
            name,
            required: false,
            present: isSecretSetForCaller(name, callerAlias, caller.env),
          });
        }
      }
    }

    res.json(out);
  });

  return router;
}

// Re-export loadRemoteConfig so callers can wire deps.loadConfig conveniently
// without a second import. Not strictly needed but useful for tests.
export { loadRemoteConfig };
