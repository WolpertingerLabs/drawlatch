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
import path from 'node:path';

import {
  loadRemoteConfig,
  resolveRoutes,
  resolvePlaceholders,
  type RemoteServerConfig,
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

// ── Types ──────────────────────────────────────────────────────────────────

export interface Session {
  channel: EncryptedChannel;
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

let resolvedRoutes: ResolvedRoute[] = [];
let rateLimitPerMinute = 60;

// ── Helpers ────────────────────────────────────────────────────────────────

function loadAuthorizedPeers(peersDir: string): PublicKeyBundle[] {
  const peers: PublicKeyBundle[] = [];
  if (!fs.existsSync(peersDir)) return peers;

  for (const entry of fs.readdirSync(peersDir)) {
    const peerDir = path.join(peersDir, entry);
    if (!fs.statSync(peerDir).isDirectory()) continue;
    try {
      peers.push(loadPublicKeys(peerDir));
      console.log(`[remote] Loaded authorized peer: ${entry}`);
    } catch (err) {
      console.error(`[remote] Failed to load peer ${entry}:`, err);
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
      auditLog(id, 'session_expired');
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

// ── Tool handlers ──────────────────────────────────────────────────────────

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  /**
   * Proxied HTTP request with route-scoped secret injection.
   */
  async http_request(input) {
    const { method, url, headers, body } = input as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    };

    // Step 1: Find matching route — try raw URL first
    let matched: ResolvedRoute | null = matchRoute(url, resolvedRoutes);
    let resolvedUrl = url;

    if (matched) {
      // Resolve URL placeholders using matched route's secrets
      resolvedUrl = resolvePlaceholders(url, matched.secrets);
    } else {
      // Try resolving URL with each route's secrets to find a match
      for (const route of resolvedRoutes) {
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

    // Step 5: Resolve body placeholders using matched route's secrets
    let resolvedBody: string | undefined;
    if (typeof body === 'string') {
      resolvedBody = resolvePlaceholders(body, matched.secrets);
    } else if (body !== null && body !== undefined) {
      resolvedBody = resolvePlaceholders(JSON.stringify(body), matched.secrets);
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
  },

  /**
   * List available routes with metadata, endpoint patterns, and secret names (not values).
   * Provides full disclosure of available routes for the local agent.
   */
  list_routes() {
    const routes = resolvedRoutes.map((route, index) => {
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

    return Promise.resolve(routes);
  },

  /**
   * Fetch documentation for a specific route.
   * Prefers openApiUrl if set, otherwise falls back to docsUrl.
   * This is a workaround for agents that cannot access external URLs directly.
   */
  async get_route_docs(input) {
    const { routeIndex } = input as { routeIndex: number };

    if (typeof routeIndex !== 'number' || routeIndex < 0 || routeIndex >= resolvedRoutes.length) {
      throw new Error(
        `Invalid route index: ${routeIndex}. Must be 0–${resolvedRoutes.length - 1}.`,
      );
    }

    const route = resolvedRoutes[routeIndex];
    const url = route.openApiUrl ?? route.docsUrl;

    if (!url) {
      throw new Error(
        `Route ${routeIndex} has no docsUrl or openApiUrl configured.`,
      );
    }

    const resp = await fetch(url, {
      headers: { Accept: 'application/json, application/yaml, text/yaml, text/html, text/plain' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(
        `Failed to fetch docs from ${url}: ${resp.status} ${resp.statusText}`,
      );
    }

    const contentType = resp.headers.get('content-type') ?? '';
    let body: unknown;

    if (contentType.includes('application/json')) {
      body = await resp.json();
    } else {
      body = await resp.text();
    }

    return {
      routeIndex,
      source: route.openApiUrl ? 'openapi' : 'docs',
      url,
      contentType,
      body,
    };
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
  authorizedPeers?: PublicKeyBundle[];
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Parse JSON for handshake endpoints
  app.use('/handshake', express.json());

  // Raw buffer for encrypted request endpoint
  app.use('/request', express.raw({ type: 'application/octet-stream', limit: '10mb' }));

  const config = options.config ?? loadRemoteConfig();
  const ownKeys = options.ownKeys ?? loadKeyBundle(config.localKeysDir);
  const authorizedPeers = options.authorizedPeers ?? loadAuthorizedPeers(config.authorizedPeersDir);

  resolvedRoutes = resolveRoutes(config.routes);
  rateLimitPerMinute = config.rateLimitPerMinute;

  console.log(`[remote] Loaded ${resolvedRoutes.length} route(s)`);
  for (const [i, route] of resolvedRoutes.entries()) {
    console.log(
      `[remote]   Route ${i}: ${Object.keys(route.secrets).length} secrets, ` +
        `${route.allowedEndpoints.length} endpoint patterns, ` +
        `${Object.keys(route.headers).length} auto-headers`,
    );
  }
  console.log(`[remote] ${authorizedPeers.length} authorized peer(s)`);
  console.log(`[remote] Rate limit: ${rateLimitPerMinute} req/min per session`);

  // ── Handshake init ─────────────────────────────────────────────────────

  app.post('/handshake/init', (req, res) => {
    try {
      const init: HandshakeInit = req.body;
      const responder = new HandshakeResponder(ownKeys, authorizedPeers);

      const { reply } = responder.processInit(init);
      const sessionKeys = responder.deriveKeys(init);

      // Store pending handshake for the finish step
      pendingHandshakes.set(sessionKeys.sessionId, {
        responder,
        init,
        createdAt: Date.now(),
      });

      // Create the session preemptively (will be activated on finish)
      sessions.set(sessionKeys.sessionId, {
        channel: new EncryptedChannel(sessionKeys),
        createdAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0,
        windowRequests: 0,
        windowStart: Date.now(),
      });

      auditLog(sessionKeys.sessionId, 'handshake_init_ok');
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
      auditLog(sessionId, 'handshake_complete');
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
      auditLog(sessionId, 'rate_limited');
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
        toolName: request.toolName,
        requestId: request.id,
      });

      // Dispatch to handler
      const handler = toolHandlers[request.toolName];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input
      if (!handler) {
        throw new Error(`Unknown tool: ${request.toolName}`);
      }

      const result = await handler(request.toolInput);

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

  return app;
}

// ── Start ──────────────────────────────────────────────────────────────────

function main(): void {
  const config = loadRemoteConfig();
  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    console.log(`[remote] Secure remote server listening on ${config.host}:${config.port}`);
  });

  // Graceful shutdown: close the server when the process receives SIGTERM or SIGINT.
  const shutdown = () => {
    console.log('[remote] Shutting down gracefully...');
    server.close(() => {
      console.log('[remote] Server closed.');
      process.exit(0);
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

// Only run when executed directly (not when imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith('remote/server.ts') || process.argv[1]?.endsWith('remote/server.js');

if (isDirectRun) {
  try {
    main();
  } catch (err: unknown) {
    console.error('[remote] Fatal error:', err);
    process.exit(1);
  }
}
