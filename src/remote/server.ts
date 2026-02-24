/**
 * Remote Secure Server — the secrets-holding side.
 *
 * Runs as an HTTP server (localhost or remote). Holds secrets and only
 * communicates through encrypted channels established via mutual auth.
 *
 * This server:
 *   - Authenticates incoming MCP proxy clients via Ed25519 signatures
 *   - Establishes encrypted channels via X25519 ECDH + AES-256-GCM
 *   - Receives encrypted tool requests, injects secrets, executes, encrypts results
 *   - Never exposes secrets in plaintext over the wire
 *   - Maintains an audit log of all operations
 *   - Rate-limits requests per session
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';

import {
  loadRemoteConfig,
  resolveRoutes,
  resolveCallerRoutes,
  resolveSecrets,
  resolvePlaceholders,
  type RemoteServerConfig,
  type CallerConfig,
  type ResolvedRoute,
} from '../shared/config.js';
import {
  loadKeyBundle,
  loadPublicKeys,
  EncryptedChannel,
  type PublicKeyBundle,
} from '../shared/crypto/index.js';
import {
  HandshakeResponder,
  type HandshakeInit,
  type HandshakeFinish,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';
import { IngestorManager } from './ingestors/index.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** An authorized peer with its alias and optional display name */
export interface AuthorizedPeer {
  /** Caller alias — the key from the callers config object */
  alias: string;
  /** Human-readable name for audit logs */
  name?: string;
  /** The peer's public keys (signing + exchange) */
  keys: PublicKeyBundle;
}

export interface Session {
  channel: EncryptedChannel;
  /** Caller alias for this session (from the matched AuthorizedPeer) */
  callerAlias: string;
  /** Per-caller resolved routes for this session */
  resolvedRoutes: ResolvedRoute[];
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  /** Requests in the current rate-limit window */
  windowRequests: number;
  windowStart: number;
}

export interface PendingHandshake {
  responder: HandshakeResponder;
  init: HandshakeInit;
  createdAt: number;
}

// ── State ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();
const pendingHandshakes = new Map<string, PendingHandshake>();

let rateLimitPerMinute = 60;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load authorized peers from per-caller config.
 * Each caller specifies its own peerKeyDir containing signing.pub.pem + exchange.pub.pem.
 */
function loadCallerPeers(callers: Record<string, CallerConfig>): AuthorizedPeer[] {
  const peers: AuthorizedPeer[] = [];

  for (const [alias, caller] of Object.entries(callers)) {
    if (!fs.existsSync(caller.peerKeyDir)) {
      console.error(`[remote] Peer key dir not found for "${alias}": ${caller.peerKeyDir}`);
      continue;
    }
    try {
      peers.push({ alias, name: caller.name, keys: loadPublicKeys(caller.peerKeyDir) });
      console.log(`[remote] Loaded authorized peer: ${alias}`);
    } catch (err) {
      console.error(`[remote] Failed to load peer ${alias}:`, err);
    }
  }
  return peers;
}

function auditLog(sessionId: string, action: string, details: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId: sessionId.substring(0, 12) + '...',
    action,
    ...details,
  };
  console.log(`[audit] ${JSON.stringify(entry)}`);
}

export function isEndpointAllowed(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true; // no restrictions if empty
  return patterns.some((pattern) => {
    // Support simple glob patterns: * matches anything within a segment, ** matches across segments
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.__DOUBLE_STAR__.')
          .replace(/\*/g, '[^/]*')
          .replace(/\.__DOUBLE_STAR__\./g, '.*') +
        '$',
    );
    return regex.test(url);
  });
}

// Re-export resolvePlaceholders from config for backward compatibility with tests
export { resolvePlaceholders } from '../shared/config.js';

/**
 * Find the first route whose allowedEndpoints match the given URL.
 * Routes with empty allowedEndpoints match nothing.
 */
export function matchRoute(url: string, routes: ResolvedRoute[]): ResolvedRoute | null {
  for (const route of routes) {
    if (route.allowedEndpoints.length > 0 && isEndpointAllowed(url, route.allowedEndpoints)) {
      return route;
    }
  }
  return null;
}

export function checkRateLimit(
  session: Pick<Session, 'windowRequests' | 'windowStart'>,
  limit: number,
): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  if (now - session.windowStart > windowMs) {
    session.windowStart = now;
    session.windowRequests = 0;
  }

  session.windowRequests++;
  return session.windowRequests <= limit;
}

// ── Session cleanup ────────────────────────────────────────────────────────

export const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
export const HANDSHAKE_TTL = 30 * 1000; // 30 seconds

export function cleanupSessions(
  sessionsMap: Map<string, Pick<Session, 'lastActivity'>>,
  pendingMap: Map<string, Pick<PendingHandshake, 'createdAt'>>,
  now: number = Date.now(),
): { expiredSessions: string[]; expiredHandshakes: string[] } {
  const expiredSessions: string[] = [];
  const expiredHandshakes: string[] = [];

  for (const [id, session] of sessionsMap) {
    if (now - session.lastActivity > SESSION_TTL) {
      const caller = 'callerAlias' in session ? (session as Session).callerAlias : undefined;
      auditLog(id, 'session_expired', caller ? { caller } : {});
      sessionsMap.delete(id);
      expiredSessions.push(id);
    }
  }

  for (const [id, hs] of pendingMap) {
    if (now - hs.createdAt > HANDSHAKE_TTL) {
      pendingMap.delete(id);
      expiredHandshakes.push(id);
    }
  }

  return { expiredSessions, expiredHandshakes };
}

setInterval(() => {
  cleanupSessions(sessions, pendingHandshakes);
}, 60_000);

// ── Proxy request execution ────────────────────────────────────────────────

export interface ProxyRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProxyRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Core proxy request execution — route matching, secret injection, and fetch.
 *
 * Used by:
 * - The remote server's `http_request` tool handler (this file)
 * - callboard's `LocalProxy` class (in-process, no encryption)
 *
 * Pure in the sense that it takes routes as input rather than reading global state.
 * The only side effect is the outbound fetch().
 */
export async function executeProxyRequest(
  input: ProxyRequestInput,
  routes: ResolvedRoute[],
): Promise<ProxyRequestResult> {
  const { method, url, headers = {}, body } = input;

  // Step 1: Find matching route — try raw URL first
  let matched: ResolvedRoute | null = matchRoute(url, routes);
  let resolvedUrl = url;

  if (matched) {
    // Resolve URL placeholders using matched route's secrets
    resolvedUrl = resolvePlaceholders(url, matched.secrets);
  } else {
    // Try resolving URL with each route's secrets to find a match
    for (const route of routes) {
      if (route.allowedEndpoints.length === 0) continue;
      const candidateUrl = resolvePlaceholders(url, route.secrets);
      if (isEndpointAllowed(candidateUrl, route.allowedEndpoints)) {
        matched = route;
        resolvedUrl = candidateUrl;
        break;
      }
    }
  }

  if (!matched) {
    throw new Error(`Endpoint not allowed: ${url}`);
  }

  // Step 2: Resolve client headers using matched route's secrets
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resolvedHeaders[k] = resolvePlaceholders(v, matched.secrets);
  }

  // Step 3: Check for header conflicts — reject if client provides a header
  // that conflicts with a route-level header (case-insensitive)
  const routeHeaderKeys = new Set(Object.keys(matched.headers).map((k) => k.toLowerCase()));
  for (const clientKey of Object.keys(resolvedHeaders)) {
    if (routeHeaderKeys.has(clientKey.toLowerCase())) {
      throw new Error(
        `Header conflict: client-provided header "${clientKey}" conflicts with a route-level header. Remove it from the request.`,
      );
    }
  }

  // Step 4: Merge route-level headers (they take effect after conflict check)
  for (const [k, v] of Object.entries(matched.headers)) {
    resolvedHeaders[k] = v;
  }

  // Step 5: Resolve body placeholders using matched route's secrets.
  // Only when the route explicitly opts in via resolveSecretsInBody — prevents
  // exfiltration of secrets by writing placeholder strings into API resources
  // and reading them back.
  let resolvedBody: string | undefined;
  if (typeof body === 'string') {
    resolvedBody = matched.resolveSecretsInBody ? resolvePlaceholders(body, matched.secrets) : body;
  } else if (body !== null && body !== undefined) {
    const serialized = JSON.stringify(body);
    resolvedBody = matched.resolveSecretsInBody
      ? resolvePlaceholders(serialized, matched.secrets)
      : serialized;
    if (!resolvedHeaders['content-type'] && !resolvedHeaders['Content-Type']) {
      resolvedHeaders['Content-Type'] = 'application/json';
    }
  }

  // Step 6: Final endpoint check on fully resolved URL
  if (!isEndpointAllowed(resolvedUrl, matched.allowedEndpoints)) {
    throw new Error(`Endpoint not allowed after resolution: ${url}`);
  }

  // Step 7: Make the actual HTTP request
  const resp = await fetch(resolvedUrl, {
    method,
    headers: resolvedHeaders,
    body: resolvedBody,
  });

  const contentType = resp.headers.get('content-type') ?? '';
  let responseBody: unknown;

  if (contentType.includes('application/json')) {
    responseBody = await resp.json();
  } else {
    responseBody = await resp.text();
  }

  return {
    status: resp.status,
    statusText: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    body: responseBody,
  };
}

// ── Tool handlers ──────────────────────────────────────────────────────────

/** Context passed to every tool handler, providing caller identity and shared services. */
export interface ToolContext {
  /** The caller alias for the session making this request. */
  callerAlias: string;
  /** The shared ingestor manager (for poll_events / ingestor_status). */
  ingestorManager: IngestorManager;
}

type ToolHandler = (
  input: Record<string, unknown>,
  routes: ResolvedRoute[],
  context: ToolContext,
) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  /**
   * Proxied HTTP request with route-scoped secret injection.
   * Delegates to the extracted executeProxyRequest() function.
   */
  async http_request(input, routes, _context) {
    return executeProxyRequest(input as unknown as ProxyRequestInput, routes);
  },

  /**
   * List available routes with metadata, endpoint patterns, and secret names (not values).
   * Provides full disclosure of available routes for the local agent.
   */
  list_routes(_input, routes, _context) {
    const routeList = routes.map((route, index) => {
      const info: Record<string, unknown> = { index };

      if (route.name) info.name = route.name;
      if (route.description) info.description = route.description;
      if (route.docsUrl) info.docsUrl = route.docsUrl;
      if (route.openApiUrl) info.openApiUrl = route.openApiUrl;

      info.allowedEndpoints = route.allowedEndpoints;
      info.secretNames = Object.keys(route.secrets);
      info.autoHeaders = Object.keys(route.headers);

      return info;
    });

    return Promise.resolve(routeList);
  },

  /**
   * Poll for new events from ingestors (Discord Gateway, webhooks, pollers).
   * Returns events since a cursor, optionally filtered by connection.
   */
  poll_events(input, _routes, context) {
    const { connection, after_id } = input as {
      connection?: string;
      after_id?: number;
    };
    const afterId = after_id ?? -1;

    if (connection) {
      return Promise.resolve(
        context.ingestorManager.getEvents(context.callerAlias, connection, afterId),
      );
    }
    return Promise.resolve(context.ingestorManager.getAllEvents(context.callerAlias, afterId));
  },

  /**
   * Get the status of all active ingestors for this caller.
   */
  ingestor_status(_input, _routes, context) {
    return Promise.resolve(context.ingestorManager.getStatuses(context.callerAlias));
  },
};

// ── Express app ────────────────────────────────────────────────────────────

/** Options for creating the app — allows dependency injection for tests */
export interface CreateAppOptions {
  /** Override config instead of loading from disk */
  config?: RemoteServerConfig;
  /** Override key bundle instead of loading from disk */
  ownKeys?: import('../shared/crypto/index.js').KeyBundle;
  /** Override authorized peers instead of loading from disk */
  authorizedPeers?: AuthorizedPeer[];
  /** Override the ingestor manager instead of creating one from config */
  ingestorManager?: IngestorManager;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Parse JSON for handshake endpoints
  app.use('/handshake', express.json());

  // Raw buffer for encrypted request endpoint
  app.use('/request', express.raw({ type: 'application/octet-stream', limit: '10mb' }));

  // Raw buffer for webhook endpoints (needed for signature verification)
  app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));

  const config = options.config ?? loadRemoteConfig();
  const ownKeys = options.ownKeys ?? loadKeyBundle(config.localKeysDir);
  const authorizedPeers = options.authorizedPeers ?? loadCallerPeers(config.callers);

  rateLimitPerMinute = config.rateLimitPerMinute;

  // Create or use the provided ingestor manager
  const ingestorManager = options.ingestorManager ?? new IngestorManager(config);
  app.locals.ingestorManager = ingestorManager;

  // Log connector and caller summary
  const connectorCount = config.connectors?.length ?? 0;
  const callerCount = Object.keys(config.callers).length;
  console.log(`[remote] ${connectorCount} custom connector(s), ${callerCount} caller(s)`);
  for (const [alias, caller] of Object.entries(config.callers)) {
    console.log(`[remote]   Caller "${alias}": ${caller.connections.length} connection(s)`);
  }
  console.log(`[remote] ${authorizedPeers.length} authorized peer(s)`);
  console.log(`[remote] Rate limit: ${rateLimitPerMinute} req/min per session`);

  // ── Handshake init ─────────────────────────────────────────────────────

  app.post('/handshake/init', (req, res) => {
    try {
      const init: HandshakeInit = req.body;
      const responder = new HandshakeResponder(
        ownKeys,
        authorizedPeers.map((p) => p.keys),
      );

      const { reply, initiatorPubKey } = responder.processInit(init);
      const sessionKeys = responder.deriveKeys(init);

      // Look up the caller alias by matching the returned PublicKeyBundle
      const matchedPeer = authorizedPeers.find((p) => p.keys === initiatorPubKey);
      const callerAlias = matchedPeer?.alias ?? 'unknown';

      // Resolve per-caller routes (with optional env overrides)
      const callerRoutes = resolveCallerRoutes(config, callerAlias);
      const caller = config.callers[callerAlias];
      const callerEnvResolved = resolveSecrets(caller?.env ?? {});
      const callerResolvedRoutes = resolveRoutes(callerRoutes, callerEnvResolved);

      // Store pending handshake for the finish step
      pendingHandshakes.set(sessionKeys.sessionId, {
        responder,
        init,
        createdAt: Date.now(),
      });

      // Create the session preemptively (will be activated on finish)
      sessions.set(sessionKeys.sessionId, {
        channel: new EncryptedChannel(sessionKeys),
        callerAlias,
        resolvedRoutes: callerResolvedRoutes,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0,
        windowRequests: 0,
        windowStart: Date.now(),
      });

      auditLog(sessionKeys.sessionId, 'handshake_init_ok', { caller: callerAlias });
      res.json(reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[remote] Handshake init failed:', message);
      res.status(403).json({ error: message });
    }
  });

  // ── Handshake finish ───────────────────────────────────────────────────

  app.post('/handshake/finish', (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing X-Session-Id header' });
      return;
    }

    const session = sessions.get(sessionId);
    const pending = pendingHandshakes.get(sessionId);

    if (!session || !pending) {
      res.status(404).json({ error: 'No pending handshake for this session' });
      return;
    }

    try {
      const finish: HandshakeFinish = req.body;
      // The responder's session keys already have the correct orientation:
      // recvKey decrypts messages from the initiator (which is what the finish msg is)
      const verified = pending.responder.verifyFinish(finish, session.channel.getKeys());

      if (!verified) {
        sessions.delete(sessionId);
        throw new Error('Finish verification failed — key derivation mismatch');
      }

      pendingHandshakes.delete(sessionId);
      auditLog(sessionId, 'handshake_complete', { caller: session.callerAlias });
      res.json({ status: 'established', sessionId });
    } catch (err) {
      pendingHandshakes.delete(sessionId);
      sessions.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[remote] Handshake finish failed:', message);
      res.status(403).json({ error: message });
    }
  });

  // ── Encrypted request ──────────────────────────────────────────────────

  app.post('/request', async (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).send('Missing X-Session-Id header');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(401).send('Unknown or expired session');
      return;
    }

    // Rate limit check
    if (!checkRateLimit(session, rateLimitPerMinute)) {
      auditLog(sessionId, 'rate_limited', { caller: session.callerAlias });
      res.status(429).send('Rate limit exceeded');
      return;
    }

    session.lastActivity = Date.now();
    session.requestCount++;

    try {
      // Decrypt the request
      const encryptedBody = Buffer.from(req.body);
      const request = session.channel.decryptJSON<ProxyRequest>(encryptedBody);

      auditLog(sessionId, 'request', {
        caller: session.callerAlias,
        toolName: request.toolName,
        requestId: request.id,
      });

      // Dispatch to handler
      const handler = toolHandlers[request.toolName];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input
      if (!handler) {
        throw new Error(`Unknown tool: ${request.toolName}`);
      }

      const context: ToolContext = {
        callerAlias: session.callerAlias,
        ingestorManager: app.locals.ingestorManager as IngestorManager,
      };
      const result = await handler(request.toolInput, session.resolvedRoutes, context);

      // Build and encrypt response
      const response: ProxyResponse = {
        type: 'proxy_response',
        id: request.id,
        success: true,
        result,
        timestamp: Date.now(),
      };

      const encrypted = session.channel.encryptJSON(response);

      auditLog(sessionId, 'response', {
        caller: session.callerAlias,
        requestId: request.id,
        success: true,
      });

      res.set('Content-Type', 'application/octet-stream');
      res.send(encrypted);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[remote] Request error (${sessionId}):`, message);

      try {
        // Try to send an encrypted error response
        const errorResponse: ProxyResponse = {
          type: 'proxy_response',
          id: 'error',
          success: false,
          error: message,
          timestamp: Date.now(),
        };
        const encrypted = session.channel.encryptJSON(errorResponse);
        res.set('Content-Type', 'application/octet-stream');
        res.send(encrypted);
      } catch {
        // If encryption fails, the session is broken
        sessions.delete(sessionId);
        res.status(500).send('Session error');
      }
    }
  });

  // ── Health check (unencrypted, no secrets exposed) ─────────────────────

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      activeSessions: sessions.size,
      uptime: process.uptime(),
    });
  });

  // ── Webhook receiver ─────────────────────────────────────────────────

  app.post('/webhooks/:path', (req, res) => {
    const webhookPath = req.params.path;
    const mgr = app.locals.ingestorManager as IngestorManager;

    // Find all ingestor instances matching this webhook path
    const ingestors = mgr.getWebhookIngestors(webhookPath);

    if (ingestors.length === 0) {
      res.status(404).json({ error: `No webhook ingestor registered for path: ${webhookPath}` });
      return;
    }

    // Ensure we have a raw Buffer for signature verification
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    // Fan out to all matching ingestors (multiple callers may share a webhook path)
    let anyAccepted = false;
    const results: { connection: string; accepted: boolean; reason?: string }[] = [];

    for (const ingestor of ingestors) {
      const result = ingestor.handleWebhook(
        req.headers as Record<string, string | string[] | undefined>,
        rawBody,
      );
      results.push({ connection: ingestor.webhookPath, ...result });
      if (result.accepted) anyAccepted = true;
    }

    // Return 200 if any ingestor accepted (GitHub retries on non-2xx)
    if (anyAccepted) {
      res.status(200).json({ received: true });
    } else {
      res.status(403).json({ error: 'Webhook rejected by all ingestors', details: results });
    }
  });

  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

function main(): void {
  const config = loadRemoteConfig();
  const app = createApp();
  const ingestorManager = app.locals.ingestorManager as IngestorManager;

  const server = app.listen(config.port, config.host, () => {
    console.log(`[remote] Secure remote server listening on ${config.host}:${config.port}`);

    // Start ingestors after the server is listening
    ingestorManager.startAll().catch((err: unknown) => {
      console.error('[remote] Failed to start ingestors:', err);
    });
  });

  // Graceful shutdown: stop ingestors, then close the server.
  const shutdown = () => {
    console.log('[remote] Shutting down gracefully...');

    ingestorManager
      .stopAll()
      .catch((err: unknown) => {
        console.error('[remote] Error stopping ingestors:', err);
      })
      .finally(() => {
        server.close(() => {
          console.log('[remote] Server closed.');
          process.exit(0);
        });
      });

    // Force exit after 10 seconds if connections don't drain
    setTimeout(() => {
      console.error('[remote] Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when executed directly (not when imported as a library).
// Check if the entry script is this file (covers both ts-node and compiled js).
// Also check PM2's pm_exec_path for cluster mode where argv[1] is PM2's internal module.
const entryScript = process.argv[1] ?? '';
const pm2ExecPath = process.env.pm_exec_path ?? '';
const isDirectRun =
  entryScript.endsWith('remote/server.ts') ||
  entryScript.endsWith('remote/server.js') ||
  pm2ExecPath.endsWith('remote/server.js');

if (isDirectRun) {
  try {
    main();
  } catch (err: unknown) {
    console.error('[remote] Fatal error:', err);
    process.exit(1);
  }
}
