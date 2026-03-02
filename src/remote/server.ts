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

import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';

import {
  loadRemoteConfig,
  saveRemoteConfig,
  resolveRoutes,
  resolveCallerRoutes,
  resolveSecrets,
  resolvePlaceholders,
  getEnvFilePath,
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

// ── Environment loading ─────────────────────────────────────────────────────

/** Load environment from ~/.drawlatch/.env, falling back to cwd .env (legacy). */
function loadEnvFile(): void {
  const configDirEnvPath = getEnvFilePath();
  if (fs.existsSync(configDirEnvPath)) {
    dotenv.config({ path: configDirEnvPath });
    return;
  }
  // Backward compat: fall back to cwd .env
  const result = dotenv.config();
  if (result.parsed) {
    console.warn(
      `[remote] Loaded .env from working directory. ` +
        `Move it to ${configDirEnvPath} for portable operation.`,
    );
  }
}

loadEnvFile();

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

  if ('toolName' in details && details.toolName === 'poll_events') {
    return;
  }

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

      if (route.alias) info.alias = route.alias;
      if (route.name) info.name = route.name;
      if (route.description) info.description = route.description;
      if (route.docsUrl) info.docsUrl = route.docsUrl;
      if (route.openApiUrl) info.openApiUrl = route.openApiUrl;

      info.allowedEndpoints = route.allowedEndpoints;
      info.secretNames = Object.keys(route.secrets);
      info.autoHeaders = Object.keys(route.headers);

      // Ingestor & testing metadata
      info.hasTestConnection = route.testConnection !== undefined;
      info.hasIngestor = route.ingestorConfig !== undefined;
      if (route.ingestorConfig) {
        info.ingestorType = route.ingestorConfig.type;
        info.hasTestIngestor = route.testIngestor !== undefined && route.testIngestor !== null;
        info.hasListenerConfig = route.listenerConfig !== undefined;
        if (route.listenerConfig) {
          info.listenerParamKeys = route.listenerConfig.fields.map((f) => f.key);
          info.supportsMultiInstance = route.listenerConfig.supportsMultiInstance ?? false;
        }
      }

      return info;
    });

    return Promise.resolve(routeList);
  },

  /**
   * Poll for new events from ingestors (Discord Gateway, webhooks, pollers).
   * Returns events since a cursor, optionally filtered by connection.
   */
  poll_events(input, _routes, context) {
    const { connection, after_id, instance_id } = input as {
      connection?: string;
      after_id?: number;
      instance_id?: string;
    };
    const afterId = after_id ?? -1;

    if (connection) {
      return Promise.resolve(
        context.ingestorManager.getEvents(context.callerAlias, connection, afterId, instance_id),
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

  /**
   * Test a connection's API credentials by executing a pre-configured,
   * non-destructive read-only request. Returns success/failure with status details.
   */
  async test_connection(input, routes, _context) {
    const { connection } = input as { connection: string };

    // Find the route matching this connection alias
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    if (!route.testConnection) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This connection does not have a test configuration.',
      };
    }

    const testConfig = route.testConnection;
    const method = testConfig.method ?? 'GET';
    const expectedStatus = testConfig.expectedStatus ?? [200];

    try {
      const result = await executeProxyRequest(
        {
          method,
          url: testConfig.url,
          headers: testConfig.headers,
          body: testConfig.body,
        },
        routes,
      );

      const isSuccess = expectedStatus.includes(result.status);
      return {
        success: isSuccess,
        connection,
        status: result.status,
        statusText: result.statusText,
        description: testConfig.description,
        ...(isSuccess
          ? {}
          : {
              error: `Unexpected status ${result.status} (expected ${expectedStatus.join(' or ')})`,
            }),
      };
    } catch (err) {
      return {
        success: false,
        connection,
        description: testConfig.description,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Test an event listener / ingestor's configuration by running a lightweight
   * verification appropriate to its type (auth check, secret check, poll check).
   */
  async test_ingestor(input, routes, _context) {
    const { connection } = input as { connection: string };

    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    if (!route.ingestorConfig) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This connection does not have an event listener.',
      };
    }

    // testIngestor is explicitly null = not testable
    if (route.testIngestor === null) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This event listener does not support testing.',
      };
    }

    if (!route.testIngestor) {
      return {
        success: false,
        connection,
        supported: false,
        error: 'This event listener does not have a test configuration.',
      };
    }

    const testConfig = route.testIngestor;

    try {
      switch (testConfig.strategy) {
        case 'webhook_verify': {
          // Verify that all required secrets are present and non-empty
          const missing: string[] = [];
          for (const secretName of testConfig.requireSecrets ?? []) {
            if (!route.secrets[secretName]) {
              missing.push(secretName);
            }
          }
          if (missing.length > 0) {
            return {
              success: false,
              connection,
              strategy: testConfig.strategy,
              description: testConfig.description,
              error: `Missing required secrets: ${missing.join(', ')}`,
            };
          }
          return {
            success: true,
            connection,
            strategy: testConfig.strategy,
            description: testConfig.description,
            message: 'All required webhook secrets are configured.',
          };
        }

        case 'websocket_auth':
        case 'http_request':
        case 'poll_once': {
          // Execute the test HTTP request
          if (!testConfig.request) {
            return {
              success: false,
              connection,
              strategy: testConfig.strategy,
              description: testConfig.description,
              error: 'Test configuration missing request details.',
            };
          }

          const method = testConfig.request.method ?? 'GET';
          const expectedStatus = testConfig.request.expectedStatus ?? [200];

          const result = await executeProxyRequest(
            {
              method,
              url: testConfig.request.url,
              headers: testConfig.request.headers,
              body: testConfig.request.body,
            },
            routes,
          );

          const isSuccess = expectedStatus.includes(result.status);
          return {
            success: isSuccess,
            connection,
            strategy: testConfig.strategy,
            status: result.status,
            statusText: result.statusText,
            description: testConfig.description,
            ...(isSuccess
              ? { message: 'Listener test passed.' }
              : { error: `Unexpected status ${result.status}` }),
          };
        }

        default:
          return {
            success: false,
            connection,
            error: `Unknown test strategy: ${String(testConfig.strategy)}`,
          };
      }
    } catch (err) {
      return {
        success: false,
        connection,
        strategy: testConfig.strategy,
        description: testConfig.description,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * List listener configuration schemas for all connections that have configurable
   * event listeners. Returns the schema fields, current values, and metadata.
   */
  list_listener_configs(_input, routes, _context) {
    const configs = routes
      .filter((r) => r.listenerConfig)
      .map((r) => ({
        connection: r.alias,
        name: r.listenerConfig!.name,
        description: r.listenerConfig!.description,
        fields: r.listenerConfig!.fields,
        ingestorType: r.ingestorConfig?.type,
        supportsMultiInstance: r.listenerConfig!.supportsMultiInstance ?? false,
        instanceKeyField: r.listenerConfig!.fields.find((f) => f.instanceKey)?.key,
      }));
    return Promise.resolve(configs);
  },

  /**
   * Resolve dynamic options for a listener configuration field.
   * Fetches options from the external API (e.g., list of Trello boards).
   */
  async resolve_listener_options(input, routes, _context) {
    const { connection, paramKey } = input as { connection: string; paramKey: string };

    const route = routes.find((r) => r.alias === connection);
    if (!route?.listenerConfig) {
      return { success: false, error: `No listener config for connection: ${connection}` };
    }

    const field = route.listenerConfig.fields.find((f) => f.key === paramKey);
    if (!field?.dynamicOptions) {
      return { success: false, error: `No dynamic options for field: ${paramKey}` };
    }

    const {
      url,
      method = 'GET',
      body,
      responsePath,
      labelField,
      valueField,
    } = field.dynamicOptions;

    try {
      const result = await executeProxyRequest({ method, url, headers: {}, body }, routes);

      // Navigate to the response path to find the items array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- navigating unknown response shape
      let items: any = result.body;
      if (responsePath) {
        for (const segment of responsePath.split('.')) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
          items = items?.[segment as keyof typeof items];
        }
      }

      if (!Array.isArray(items)) {
        return { success: false, error: 'Response did not contain an array at the expected path.' };
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const options = items.map((item) => ({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        value: item[valueField],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        label: item[labelField],
      }));

      return { success: true, connection, paramKey, options };
    } catch (err) {
      return {
        success: false,
        connection,
        paramKey,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Start, stop, or restart an event listener for a specific connection.
   */
  async control_listener(input, _routes, context) {
    const { connection, action, instance_id } = input as {
      connection: string;
      action: 'start' | 'stop' | 'restart';
      instance_id?: string;
    };

    const mgr = context.ingestorManager;

    try {
      switch (action) {
        case 'start':
          return await mgr.startOne(context.callerAlias, connection, instance_id);
        case 'stop':
          return await mgr.stopOne(context.callerAlias, connection, instance_id);
        case 'restart':
          return await mgr.restartOne(context.callerAlias, connection, instance_id);
        default:
          return { success: false, error: `Unknown action: ${String(action)}` };
      }
    } catch (err) {
      return {
        success: false,
        connection,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Read current listener parameter overrides for a connection.
   * Returns current param values and schema defaults for form population.
   */
  get_listener_params(input, routes, context) {
    const { connection, instance_id } = input as {
      connection: string;
      instance_id?: string;
    };

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Unknown connection: ${connection}`,
      });
    }

    if (!route.listenerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: 'This connection does not have a listener configuration.',
      });
    }

    // Build defaults from schema fields
    const defaults: Record<string, unknown> = {};
    for (const field of route.listenerConfig.fields) {
      if (field.default !== undefined) {
        defaults[field.key] = field.default;
      }
    }

    // Load config to read current overrides
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias];
    if (!callerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      });
    }

    let params: Record<string, unknown> = {};

    if (instance_id) {
      // Multi-instance: read from listenerInstances
      const instanceOverrides = callerConfig.listenerInstances?.[connection]?.[instance_id];
      if (!instanceOverrides) {
        return Promise.resolve({
          success: false,
          connection,
          instance_id,
          error: `Instance not found: ${instance_id}`,
        });
      }
      params = instanceOverrides.params ?? {};
    } else {
      // Single-instance: read from ingestorOverrides
      const overrides = callerConfig.ingestorOverrides?.[connection];
      params = overrides?.params ?? {};
    }

    // When no instance_id is given on a multi-instance connection, include
    // the list of configured instance IDs so callers can discover them
    // without needing a separate list_listener_instances call.
    let instances: string[] | undefined;
    if (!instance_id && route.listenerConfig?.supportsMultiInstance) {
      const instanceMap = callerConfig.listenerInstances?.[connection] ?? {};
      instances = Object.keys(instanceMap);
    }

    return Promise.resolve({
      success: true,
      connection,
      ...(instance_id && { instance_id }),
      params,
      defaults,
      ...(instances !== undefined && { instances }),
    });
  },

  /**
   * Add or edit listener parameter overrides for a connection.
   * Merges params into existing config. For multi-instance, set create_instance
   * to true to create a new instance if it doesn't exist.
   * After saving, restarts the affected ingestor so new params take effect immediately.
   */
  async set_listener_params(input, routes, context) {
    const { connection, instance_id, params, create_instance } = input as {
      connection: string;
      instance_id?: string;
      params: Record<string, unknown>;
      create_instance?: boolean;
    };

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return { success: false, connection, error: `Unknown connection: ${connection}` };
    }

    if (!route.listenerConfig) {
      return {
        success: false,
        connection,
        error: 'This connection does not have a listener configuration.',
      };
    }

    // Validate param keys against schema
    const validKeys = new Set(route.listenerConfig.fields.map((f) => f.key));
    const unknownKeys = Object.keys(params).filter((k) => !validKeys.has(k));
    if (unknownKeys.length > 0) {
      return {
        success: false,
        connection,
        error: `Unknown parameter keys: ${unknownKeys.join(', ')}. Valid keys: ${Array.from(validKeys).join(', ')}`,
      };
    }

    // Load config, modify, save
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias];
    if (!callerConfig) {
      return {
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      };
    }

    let mergedParams: Record<string, unknown>;

    if (instance_id) {
      // Multi-instance: write to listenerInstances
      callerConfig.listenerInstances ??= {};
      callerConfig.listenerInstances[connection] ??= {};

      const existing = callerConfig.listenerInstances[connection][instance_id];

      if (!existing && !create_instance) {
        return {
          success: false,
          connection,
          instance_id,
          error: `Instance "${instance_id}" does not exist. Set create_instance to true to create it.`,
        };
      }

      if (existing) {
        existing.params = { ...(existing.params ?? {}), ...params };
        mergedParams = existing.params;
      } else {
        callerConfig.listenerInstances[connection][instance_id] = { params };
        mergedParams = params;
      }
    } else {
      // Single-instance: write to ingestorOverrides
      callerConfig.ingestorOverrides ??= {};
      callerConfig.ingestorOverrides[connection] ??= {};
      const overrides = callerConfig.ingestorOverrides[connection];
      overrides.params = { ...(overrides.params ?? {}), ...params };
      mergedParams = overrides.params;
    }

    saveRemoteConfig(config);

    // Restart the affected ingestor so new params take effect immediately.
    // This matches callboard's local-proxy behavior (which calls reinitialize()).
    const mgr = context.ingestorManager;
    if (mgr.has(context.callerAlias, connection, instance_id)) {
      try {
        await mgr.restartOne(context.callerAlias, connection, instance_id);
      } catch (err) {
        // Config was saved successfully — log the restart failure but don't fail the operation
        console.error(
          `[remote] Warning: params saved but failed to restart ingestor ${context.callerAlias}:${connection}${instance_id ? `:${instance_id}` : ''}:`,
          err,
        );
        return {
          success: true,
          connection,
          ...(instance_id && { instance_id }),
          params: mergedParams,
          warning:
            'Params saved but ingestor restart failed. Use control_listener to restart manually.',
        };
      }
    }

    return {
      success: true,
      connection,
      ...(instance_id && { instance_id }),
      params: mergedParams,
    };
  },

  /**
   * List all configured listener instances for a multi-instance connection.
   * Returns every instance from config (including stopped/disabled ones),
   * unlike ingestor_status which only shows running instances.
   */
  list_listener_instances(input, routes, context) {
    const { connection } = input as { connection: string };

    // Find the route for this connection
    const route = routes.find((r) => r.alias === connection);
    if (!route) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Unknown connection: ${connection}`,
      });
    }

    if (!route.listenerConfig?.supportsMultiInstance) {
      return Promise.resolve({
        success: false,
        connection,
        error: 'This connection does not support multi-instance listeners.',
      });
    }

    // Read from config
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias];
    if (!callerConfig) {
      return Promise.resolve({
        success: false,
        connection,
        error: `Caller not found: ${context.callerAlias}`,
      });
    }

    const instanceMap = callerConfig.listenerInstances?.[connection] ?? {};
    const instances = Object.entries(instanceMap).map(([instanceId, overrides]) => ({
      instanceId,
      disabled: overrides?.disabled ?? false,
      params: overrides?.params ?? {},
    }));

    return Promise.resolve({
      success: true,
      connection,
      instances,
    });
  },

  /**
   * Delete a multi-instance listener instance.
   * Removes from config and stops the running ingestor if active.
   */
  async delete_listener_instance(input, _routes, context) {
    const { connection, instance_id } = input as {
      connection: string;
      instance_id: string;
    };

    // Load config
    const config = loadRemoteConfig();
    const callerConfig = config.callers[context.callerAlias];
    if (!callerConfig) {
      return {
        success: false,
        connection,
        instance_id,
        error: `Caller not found: ${context.callerAlias}`,
      };
    }

    const instances = callerConfig.listenerInstances?.[connection];
    if (!instances || !(instance_id in instances)) {
      return {
        success: false,
        connection,
        instance_id,
        error: `Instance "${instance_id}" not found for connection "${connection}".`,
      };
    }

    // Stop the running ingestor if active
    const mgr = context.ingestorManager;
    if (mgr.has(context.callerAlias, connection, instance_id)) {
      try {
        await mgr.stopOne(context.callerAlias, connection, instance_id);
      } catch (err) {
        // Log but don't fail the delete
        console.error(
          `[remote] Warning: failed to stop ingestor ${context.callerAlias}:${connection}:${instance_id}:`,
          err,
        );
      }
    }

    // Remove from config
    delete instances[instance_id];

    // Clean up empty maps
    if (Object.keys(instances).length === 0) {
      delete callerConfig.listenerInstances![connection];
      if (Object.keys(callerConfig.listenerInstances!).length === 0) {
        delete callerConfig.listenerInstances;
      }
    }

    saveRemoteConfig(config);

    return { success: true, connection, instance_id };
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
      const callerEnvResolved = resolveSecrets(caller.env ?? {});
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
        toolName: request.toolName,
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
      tunnelUrl: process.env.DRAWLATCH_TUNNEL_URL ?? null,
    });
  });

  // ── Webhook receiver ─────────────────────────────────────────────────

  // Trello (and potentially other services) send a HEAD request to the
  // callback URL to verify it is reachable before activating the webhook.
  // Respond with 200 if at least one ingestor is registered for the path.
  app.head('/webhooks/:path', (req, res) => {
    const webhookPath = req.params.path;
    const mgr = app.locals.ingestorManager as IngestorManager;
    const ingestors = mgr.getWebhookIngestors(webhookPath);

    if (ingestors.length === 0) {
      res.status(404).end();
    } else {
      res.status(200).end();
    }
  });

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

export function main(): void {
  const config = loadRemoteConfig();
  const port = process.env.DRAWLATCH_PORT ? parseInt(process.env.DRAWLATCH_PORT, 10) : config.port;
  const host = process.env.DRAWLATCH_HOST ?? config.host;
  const useTunnel = process.env.DRAWLATCH_TUNNEL === '1';
  const app = createApp();
  const ingestorManager = app.locals.ingestorManager as IngestorManager;

  // Holds the tunnel stop function if a tunnel is active (set inside the
  // listen callback, read by the shutdown handler — both share this scope).
  let stopTunnel: (() => Promise<void>) | undefined;

  const server = app.listen(port, host, async () => {
    console.log(`[remote] Secure remote server listening on ${host}:${port}`);

    // If a tunnel was requested, start it before ingestors so that
    // process.env.DRAWLATCH_TUNNEL_URL is available during secret resolution.
    if (useTunnel) {
      try {
        const { startTunnel } = await import('./tunnel.js');
        const tunnel = await startTunnel({ port, host });
        stopTunnel = tunnel.stop;

        process.env.DRAWLATCH_TUNNEL_URL = tunnel.url;

        // Auto-populate callback URL env vars for webhook ingestors whose
        // connection templates reference an env var that is not yet set.
        for (const [callerAlias, callerConfig] of Object.entries(config.callers)) {
          const rawRoutes = resolveCallerRoutes(config, callerAlias);
          for (const route of rawRoutes) {
            const callbackTpl = route.ingestor?.webhook?.callbackUrl;
            const webhookPath = route.ingestor?.webhook?.path;
            if (!callbackTpl || !webhookPath) continue;

            // Extract env var name from "${VAR}" pattern
            const match = /^\$\{(\w+)\}$/.exec(callbackTpl);
            if (match) {
              const envVar = match[1];
              if (!process.env[envVar]) {
                const fullUrl = `${tunnel.url}/webhooks/${webhookPath}`;
                process.env[envVar] = fullUrl;
                console.log(`[remote] Auto-set ${envVar}=${fullUrl}`);
              }
            }
          }
        }

        console.log(`[remote] Tunnel active: ${tunnel.url}`);
        console.log(`[remote] Webhook URL:   ${tunnel.url}/webhooks/<path>`);
      } catch (err) {
        console.error('[remote] Failed to start tunnel:', err);
        console.error('[remote] Continuing without tunnel. Webhooks will only work on localhost.');
      }
    }

    // Start ingestors after tunnel (if any) is ready
    ingestorManager.startAll().catch((err: unknown) => {
      console.error('[remote] Failed to start ingestors:', err);
    });
  });

  // Graceful shutdown: stop tunnel, then ingestors, then close the server.
  const shutdown = () => {
    console.log('[remote] Shutting down gracefully...');

    // Stop tunnel first (fast — just kills a child process)
    const tunnelDone = stopTunnel
      ? stopTunnel().catch((err: unknown) => {
          console.error('[remote] Error stopping tunnel:', err);
        })
      : Promise.resolve();

    tunnelDone.then(() => {
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
const entryScript = process.argv[1] ?? '';
const isDirectRun =
  entryScript.endsWith('remote/server.ts') || entryScript.endsWith('remote/server.js');

if (isDirectRun) {
  try {
    main();
  } catch (err: unknown) {
    console.error('[remote] Fatal error:', err);
    process.exit(1);
  }
}
