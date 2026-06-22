/**
 * Canonical MCP tool implementations — the single source of truth.
 *
 * These handlers implement every proxy/management tool drawlatch exposes:
 *   http_request, list_routes, poll_events, ingestor_status,
 *   test_connection, test_ingestor, control_listener,
 *   list_listener_configs, resolve_listener_options,
 *   get/set_listener_params, list/delete_listener_instance,
 *   list_connection_templates, set_connection_enabled,
 *   set_secrets, get_secret_status.
 *
 * Consumed by:
 *   - The remote secure server's `/request` dispatch (src/remote/server.ts)
 *   - The password-gated admin API (src/remote/admin-mutations.ts)
 *   - Any in-process host (e.g. callboard) that imports
 *     `@wolpertingerlabs/drawlatch/remote/tool-dispatch` instead of
 *     re-implementing a LocalProxy.
 *
 * Pure in the sense that handlers take `routes` + `context` as input rather
 * than reading global session state. The only side effects are the outbound
 * fetch() and config/.env writes (which mirror what the live daemon does).
 */

import {
  loadRemoteConfig,
  saveRemoteConfig,
  resolvePlaceholders,
  type CallerConfig,
  type IngestorOverrides,
  type ResolvedRoute,
} from '../shared/config.js';
import { listConnectionTemplates } from '../shared/connections.js';
import { isSecretSetForCaller, setCallerSecrets } from '../shared/env-utils.js';
import type { IngestorManager } from './ingestors/index.js';
import type { TokenManager } from './oauth/token-manager.js';
import { OAuth2InvalidGrantError, OAuth2RefreshError } from './oauth/token-manager.js';
import { getSharedTokenManager } from './oauth/shared-token-manager.js';

// ── Endpoint matching ────────────────────────────────────────────────────────

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

// ── Proxy request execution ────────────────────────────────────────────────

/** A file attachment transmitted as base64 data through the encrypted channel. */
export interface FileAttachment {
  /** Form field name (e.g., "files[0]", "file", "attachment") */
  field: string;
  /** Base64-encoded file content */
  data: string;
  /** Filename for the upload */
  filename: string;
  /** MIME type (e.g., "image/png", "application/pdf") */
  contentType: string;
}

export interface ProxyRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** File attachments — triggers multipart/form-data encoding */
  files?: FileAttachment[];
  /** Form field name for the JSON body part (default: "payload_json") */
  bodyFieldName?: string;
}

export interface ProxyRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Optional collaborators for OAuth2-backed routes. When a matched route carries
 * an `oauth2` block, the access token is obtained from `tokenManager`, scoped to
 * (connection alias, `caller`). Omitted (or defaulted) for non-oauth2 routes,
 * for which behaviour is byte-for-byte unchanged.
 */
export interface ProxyRequestOptions {
  /** Token manager used to mint/refresh OAuth2 access tokens. Defaults to the
   *  process-wide shared instance so the request path and the poll ingestor
   *  share one token cache. Tests inject a stubbed manager here. */
  tokenManager?: TokenManager;
  /** Caller alias the OAuth2 token is scoped to (the (connection, caller) key).
   *  Defaults to "unknown" — only relevant for oauth2 routes. */
  caller?: string;
}

/**
 * Core proxy request execution — route matching, secret injection, and fetch.
 *
 * Pure in the sense that it takes routes as input rather than reading global
 * state. The only side effect is the outbound fetch().
 *
 * For routes carrying an `oauth2` block, the outgoing `Authorization` header is
 * set to `Bearer <token>` minted by the {@link TokenManager} and a single
 * 401-driven force-refresh + retry is performed (see the oauth2 branch below).
 */
export async function executeProxyRequest(
  input: ProxyRequestInput,
  routes: ResolvedRoute[],
  options: ProxyRequestOptions = {},
): Promise<ProxyRequestResult> {
  const { method, url, headers = {}, body, files, bodyFieldName } = input;

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
  let fetchBody: string | FormData | undefined;

  if (files?.length) {
    // ── Multipart mode: build FormData with file attachments ──
    const form = new FormData();

    // Add the JSON body as a named part (default: "payload_json" for Discord-style APIs)
    if (body !== null && body !== undefined) {
      const serialized = typeof body === 'string' ? body : JSON.stringify(body);
      const resolvedPayload = matched.resolveSecretsInBody
        ? resolvePlaceholders(serialized, matched.secrets)
        : serialized;
      form.append(bodyFieldName ?? 'payload_json', resolvedPayload);
    }

    // Attach each file from base64 data
    for (const file of files) {
      const buffer = Buffer.from(file.data, 'base64');
      const blob = new Blob([buffer], { type: file.contentType });
      form.append(file.field, blob, file.filename);
    }

    fetchBody = form;
    // Let fetch auto-set Content-Type with the correct multipart boundary —
    // remove any Content-Type that may have been set by route headers
    delete resolvedHeaders['Content-Type'];
    delete resolvedHeaders['content-type'];
  } else {
    // ── Standard JSON/string body ──
    if (typeof body === 'string') {
      fetchBody = matched.resolveSecretsInBody ? resolvePlaceholders(body, matched.secrets) : body;
    } else if (body !== null && body !== undefined) {
      const serialized = JSON.stringify(body);
      fetchBody = matched.resolveSecretsInBody
        ? resolvePlaceholders(serialized, matched.secrets)
        : serialized;
      if (!resolvedHeaders['content-type'] && !resolvedHeaders['Content-Type']) {
        resolvedHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  // Step 6: Final endpoint check on fully resolved URL
  if (!isEndpointAllowed(resolvedUrl, matched.allowedEndpoints)) {
    throw new Error(`Endpoint not allowed after resolution: ${url}`);
  }

  // Step 7: Make the actual HTTP request.
  //
  // Non-oauth2 routes: a single plain fetch — behaviour is byte-for-byte
  // unchanged from before this card. The oauth2 branch below is purely additive.
  let resp: Response;

  if (matched.oauth2) {
    // ── OAuth2 route: inject a managed Bearer token, with 401 force-refresh. ──
    //
    // CONTRACT FOR CARD 4 (Spotify templates) — DO NOT declare a static
    // `Authorization` header on an oauth2 route. The token minted here
    // OVERRIDES any Authorization the template/client may have set: we delete
    // every casing of `Authorization` before applying the managed token, so a
    // static one would be silently dropped. Templates must leave Authorization
    // to the TokenManager.
    const tokenManager = options.tokenManager ?? getSharedTokenManager();
    const caller = options.caller ?? 'unknown';
    const oauth2 = matched.oauth2;
    // Resolve secret *names* to their caller-scoped values using the SAME
    // resolved-secret map the request path already uses. Card 2 expects exactly
    // `(name) => route.secrets[name]` semantics.
    const resolveSecret = (name: string): string | undefined => matched.secrets[name];
    const tokenKey = { connection: matched.alias ?? resolvedUrl, caller };

    const applyBearer = (token: string): void => {
      // Override any Authorization set by the template or the client (any casing).
      delete resolvedHeaders.Authorization;
      delete resolvedHeaders.authorization;
      resolvedHeaders.Authorization = `Bearer ${token}`;
    };

    const doFetch = (): Promise<Response> =>
      fetch(resolvedUrl, { method, headers: resolvedHeaders, body: fetchBody });

    let token: string;
    try {
      token = await tokenManager.getAccessToken(tokenKey, oauth2, resolveSecret);
    } catch (err) {
      throw asAuthError(err, matched.alias ?? 'connection');
    }
    applyBearer(token);

    resp = await doFetch();

    // 401 recovery: force ONE refresh + ONE retry, guarded so it can never loop.
    // `retried` flips to true on the single retry; the `&& !retried` condition
    // means a still-401 response after the retry falls straight through and is
    // returned as-is. Non-401 responses are never retried here.
    let retried = false;
    while (resp.status === 401 && !retried) {
      retried = true;
      let freshToken: string;
      try {
        // forceRefresh (NOT invalidate): preserves a rotated refresh token.
        freshToken = await tokenManager.getAccessToken(tokenKey, oauth2, resolveSecret, {
          forceRefresh: true,
        });
      } catch (err) {
        throw asAuthError(err, matched.alias ?? 'connection');
      }
      applyBearer(freshToken);
      resp = await doFetch();
    }
  } else {
    resp = await fetch(resolvedUrl, {
      method,
      headers: resolvedHeaders,
      body: fetchBody,
    });
  }

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

/**
 * Translate a TokenManager error into a clear request-path failure WITHOUT
 * leaking any token material. A terminal `invalid_grant` becomes a re-auth
 * error; a transient refresh failure surfaces as an upstream auth failure — we
 * never silently fall through to an unauthenticated request.
 */
function asAuthError(err: unknown, connection: string): Error {
  if (err instanceof OAuth2InvalidGrantError) {
    return new Error(
      `OAuth2 authentication failed for connection "${connection}": the credentials are no longer valid and the connection needs to be re-authorized.`,
    );
  }
  if (err instanceof OAuth2RefreshError) {
    return new Error(
      `OAuth2 token refresh failed for connection "${connection}"` +
        (err.status !== undefined ? ` (HTTP ${err.status})` : '') +
        '. The upstream token endpoint could not issue an access token.',
    );
  }
  // Unknown error — re-throw as-is rather than swallowing it. (Still no token
  // material: TokenManager never puts secrets in its error messages.)
  return err instanceof Error ? err : new Error(String(err));
}

// ── Tool handlers ──────────────────────────────────────────────────────────

/** Context passed to every tool handler, providing caller identity and shared services. */
export interface ToolContext {
  /** The caller alias for the session making this request. */
  callerAlias: string;
  /** The shared ingestor manager (for poll_events / ingestor_status). */
  ingestorManager: IngestorManager;
  /** Re-resolve routes for all sessions belonging to this caller.
   *  Call after secrets or connection list changes. */
  refreshRoutes: () => void;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  routes: ResolvedRoute[],
  context: ToolContext,
) => Promise<unknown> | object;

export const toolHandlers: Record<string, ToolHandler> = {
  /**
   * Proxied HTTP request with route-scoped secret injection.
   * Delegates to the extracted executeProxyRequest() function.
   */
  async http_request(input, routes, context) {
    // Scope OAuth2 tokens to the caller making this request, using the shared
    // TokenManager (so the request path and poll ingestor share one cache).
    return executeProxyRequest(input as unknown as ProxyRequestInput, routes, {
      caller: context.callerAlias,
    });
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
      if (route.stability) info.stability = route.stability;
      if (route.category) info.category = route.category;

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
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
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
    if (!instance_id && route.listenerConfig.supportsMultiInstance) {
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
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
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

      const existing = callerConfig.listenerInstances[connection][instance_id] as
        | IngestorOverrides
        | undefined;

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
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
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
      disabled: overrides.disabled ?? false,
      params: overrides.params ?? {},
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
    const callerConfig = config.callers[context.callerAlias] as CallerConfig | undefined;
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
        await mgr.stopOne(context.callerAlias, connection, instance_id, { permanent: true });
      } catch (err) {
        // Log but don't fail the delete
        console.error(
          `[remote] Warning: failed to stop ingestor ${context.callerAlias}:${connection}:${instance_id}:`,
          err,
        );
      }
    }

    // Remove from config
    const { [instance_id]: _removed, ...remainingInstances } = instances;

    // Clean up empty maps
    if (Object.keys(remainingInstances).length === 0) {
      if (callerConfig.listenerInstances) {
        const { [connection]: _removedConn, ...remainingConns } = callerConfig.listenerInstances;
        if (Object.keys(remainingConns).length === 0) {
          delete callerConfig.listenerInstances;
        } else {
          callerConfig.listenerInstances = remainingConns;
        }
      }
    } else {
      callerConfig.listenerInstances![connection] = remainingInstances;
    }

    saveRemoteConfig(config);

    return { success: true, connection, instance_id };
  },

  // ── Config management tools ─────────────────────────────────────────────

  /**
   * List all available connection templates with caller-specific status.
   * Returns template metadata, which ones the caller has enabled,
   * and which secrets are configured.
   */
  list_connection_templates: (
    _input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];
    const enabledSet = new Set(caller.connections);

    const templates = listConnectionTemplates();

    return templates.map((t) => {
      const callerEnv = caller.env;
      const requiredSecretsSet: Record<string, boolean> = {};
      for (const s of t.requiredSecrets) {
        requiredSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
      }
      const optionalSecretsSet: Record<string, boolean> = {};
      for (const s of t.optionalSecrets) {
        optionalSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
      }

      return {
        alias: t.alias,
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
        ...(t.docsUrl !== undefined && { docsUrl: t.docsUrl }),
        ...(t.openApiUrl !== undefined && { openApiUrl: t.openApiUrl }),
        stability: t.stability,
        category: t.category,
        requiredSecrets: t.requiredSecrets,
        optionalSecrets: t.optionalSecrets,
        hasIngestor: t.hasIngestor,
        ...(t.ingestorType !== undefined && { ingestorType: t.ingestorType }),
        allowedEndpoints: t.allowedEndpoints,
        enabled: enabledSet.has(t.alias),
        requiredSecretsSet,
        optionalSecretsSet,
      };
    });
  },

  /**
   * Enable or disable a connection for the authenticated caller.
   */
  set_connection_enabled: async (
    input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const connection = input.connection as string;
    const enabled = input.enabled as boolean;

    if (!connection || typeof enabled !== 'boolean') {
      throw new Error('Required: connection (string) and enabled (boolean)');
    }

    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];

    // Verify the connection template exists (built-in or custom connector)
    const connectorAliases = new Set((config.connectors ?? []).map((c) => c.alias).filter(Boolean));
    const templateAliases = new Set(listConnectionTemplates().map((t) => t.alias));
    if (!connectorAliases.has(connection) && !templateAliases.has(connection)) {
      throw new Error(`Unknown connection: ${connection}`);
    }

    const connectionSet = new Set(caller.connections);

    if (enabled) {
      connectionSet.add(connection);
    } else {
      connectionSet.delete(connection);

      // Stop any running ingestors for this connection
      const ingestorManager = context.ingestorManager;
      try {
        await ingestorManager.stopOne(context.callerAlias, connection);
      } catch {
        // Ingestor may not be running — that's fine
      }
    }

    caller.connections = [...connectionSet];
    saveRemoteConfig(config);

    // Invalidate cached resolved routes so connection changes take effect immediately
    context.refreshRoutes();

    return { success: true, connection, enabled };
  },

  /**
   * Set or delete secrets for the authenticated caller.
   * Uses prefixed env vars to prevent cross-caller collisions.
   */
  set_secrets: (input: Record<string, unknown>, _routes: ResolvedRoute[], context: ToolContext) => {
    const secrets = input.secrets as Record<string, string> | undefined;

    if (!secrets || typeof secrets !== 'object') {
      throw new Error('Required: secrets (Record<string, string>)');
    }

    const config = loadRemoteConfig();

    const { config: updatedConfig, status } = setCallerSecrets(
      secrets,
      context.callerAlias,
      config,
    );

    saveRemoteConfig(updatedConfig);

    // Invalidate cached resolved routes so new secrets take effect immediately
    context.refreshRoutes();

    return { success: true, secretsSet: status };
  },

  /**
   * Check which secrets are set for the authenticated caller (never returns values).
   */
  get_secret_status: (
    input: Record<string, unknown>,
    _routes: ResolvedRoute[],
    context: ToolContext,
  ) => {
    const connection = input.connection as string;

    if (!connection) {
      throw new Error('Required: connection (string)');
    }

    // Find the connection template
    const templates = listConnectionTemplates();
    const template = templates.find((t) => t.alias === connection);
    if (!template) {
      throw new Error(`Unknown connection: ${connection}`);
    }

    const config = loadRemoteConfig();
    const caller = config.callers[context.callerAlias];
    const callerEnv = caller.env;

    const requiredSecretsSet: Record<string, boolean> = {};
    for (const s of template.requiredSecrets) {
      requiredSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
    }

    const optionalSecretsSet: Record<string, boolean> = {};
    for (const s of template.optionalSecrets) {
      optionalSecretsSet[s] = isSecretSetForCaller(s, context.callerAlias, callerEnv);
    }

    return {
      success: true,
      connection,
      requiredSecretsSet,
      optionalSecretsSet,
    };
  },
};

/**
 * Dispatch a single tool call by name. Throws on unknown tool.
 *
 * The canonical entry point for in-process hosts (admin API, callboard) that
 * want to invoke a tool without going through the encrypted `/request` path.
 */
export async function dispatchTool(
  toolName: string,
  input: Record<string, unknown>,
  routes: ResolvedRoute[],
  context: ToolContext,
): Promise<unknown> {
  const handler = toolHandlers[toolName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return handler(input, routes, context);
}
