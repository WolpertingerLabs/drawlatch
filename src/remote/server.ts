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

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, resolveSecrets } from '../shared/config.js';
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

let secrets: Record<string, string> = {};
let allowedEndpoints: string[] = [];
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

export function resolvePlaceholders(str: string, secretsMap: Record<string, string>): string {
  return str.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    if (name in secretsMap) return secretsMap[name];
    console.error(`[remote] Warning: placeholder ${match} not found in secrets`);
    return match;
  });
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
   * Proxied HTTP request with secret injection.
   */
  async http_request(input) {
    const { method, url, headers, body } = input as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    };

    // Resolve secret placeholders in URL and headers
    const resolvedUrl = resolvePlaceholders(url, secrets);
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      resolvedHeaders[k] = resolvePlaceholders(v, secrets);
    }

    // Check endpoint allowlist
    if (!isEndpointAllowed(resolvedUrl, allowedEndpoints)) {
      throw new Error(`Endpoint not allowed: ${url}`);
    }

    // Resolve body placeholders if it's a string
    let resolvedBody: string | undefined;
    if (typeof body === 'string') {
      resolvedBody = resolvePlaceholders(body, secrets);
    } else if (body !== null && body !== undefined) {
      resolvedBody = resolvePlaceholders(JSON.stringify(body), secrets);
      if (!resolvedHeaders['content-type'] && !resolvedHeaders['Content-Type']) {
        resolvedHeaders['Content-Type'] = 'application/json';
      }
    }

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
   * List available secret names (not values).
   */
  list_secrets() {
    return Promise.resolve(Object.keys(secrets));
  },
};

// ── Express app ────────────────────────────────────────────────────────────

/** Options for creating the app — allows dependency injection for tests */
export interface CreateAppOptions {
  /** Override config instead of loading from disk */
  config?: import('../shared/config.js').Config;
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

  const config = options.config ?? loadConfig();
  const ownKeys = options.ownKeys ?? loadKeyBundle(config.remote.localKeysDir);
  const authorizedPeers =
    options.authorizedPeers ?? loadAuthorizedPeers(config.remote.authorizedPeersDir);

  secrets = resolveSecrets(config.remote.secrets);
  allowedEndpoints = config.remote.allowedEndpoints;
  rateLimitPerMinute = config.remote.rateLimitPerMinute;

  console.log(`[remote] Loaded ${Object.keys(secrets).length} secrets`);
  console.log(`[remote] ${authorizedPeers.length} authorized peer(s)`);
  console.log(`[remote] ${allowedEndpoints.length} allowed endpoint pattern(s)`);
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
  const config = loadConfig();
  const app = createApp();

  const server = app.listen(config.remote.port, config.remote.host, () => {
    console.log(
      `[remote] Secure remote server listening on ${config.remote.host}:${config.remote.port}`,
    );
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
