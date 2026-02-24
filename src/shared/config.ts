/**
 * Configuration schema and loading for MCP proxy and remote server.
 *
 * Config files:
 *   - proxy.config.json  — MCP proxy (local) settings
 *   - remote.config.json — Remote server settings
 *
 * Each loader falls back to a legacy combined config.json (if present)
 * for backward compatibility, then to built-in defaults.
 *
 * Keys directory: .drawlatch/keys/
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConnection } from './connections.js';
import type { IngestorConfig } from '../remote/ingestors/types.js';

/** Resolve the base config directory at call time (not import time).
 *  Defaults to .drawlatch/ in the current working directory (repo-local).
 *  Override with MCP_CONFIG_DIR env var for custom deployments.
 *
 *  These are functions (not constants) so that process.env.MCP_CONFIG_DIR can
 *  be set at runtime before the first call — important for hosts like
 *  callboard that configure the path after ESM imports are resolved. */
export function getConfigDir(): string {
  return process.env.MCP_CONFIG_DIR ?? path.join(process.cwd(), '.drawlatch');
}
export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}
export function getProxyConfigPath(): string {
  return path.join(getConfigDir(), 'proxy.config.json');
}
export function getRemoteConfigPath(): string {
  return path.join(getConfigDir(), 'remote.config.json');
}
export function getKeysDir(): string {
  return path.join(getConfigDir(), 'keys');
}
export function getLocalKeysDir(): string {
  return path.join(getKeysDir(), 'local');
}
export function getRemoteKeysDir(): string {
  return path.join(getKeysDir(), 'remote');
}
export function getPeerKeysDir(): string {
  return path.join(getKeysDir(), 'peers');
}

/** MCP proxy (local) configuration */
export interface ProxyConfig {
  /** Remote server URL */
  remoteUrl: string;
  /** Key alias — resolved to keys/local/<alias>/.
   *  Overridden by the MCP_KEY_ALIAS env var at runtime.
   *  When set, takes precedence over localKeysDir. */
  localKeyAlias?: string;
  /** Path to our own key bundle (full-path override; ignored when alias is set) */
  localKeysDir: string;
  /** Path to the remote server's public keys */
  remotePublicKeysDir: string;
  /** Connection timeout (ms) */
  connectTimeout: number;
  /** Request timeout (ms) */
  requestTimeout: number;
}

/** A single route / connector definition — scopes secrets and headers to a set of endpoints */
export interface Route {
  /** Alias for referencing this connector from caller connection lists.
   *  Required for custom connectors that callers need to reference by name. */
  alias?: string;
  /** Human-readable name for this route (e.g., "GitHub API", "Stripe Payments").
   *  Optional but recommended for discoverability by the local agent. */
  name?: string;
  /** Short description of what this route provides or what it's used for.
   *  Optional — helps the agent understand the route's purpose. */
  description?: string;
  /** URL linking to API documentation for the service behind this route.
   *  Optional — helps the agent find usage instructions. */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec (JSON or YAML) for this route's API.
   *  Optional — provides more structured, agent-friendly documentation. */
  openApiUrl?: string;
  /** Headers to inject automatically into outgoing requests for this route.
   *  These MUST NOT conflict with client-provided headers (request is rejected on conflict).
   *  Values may contain ${VAR} placeholders resolved against this route's secrets. */
  headers?: Record<string, string>;
  /** Secrets available for ${VAR} placeholder resolution in this route only.
   *  Values can be literals or "${ENV_VAR}" references resolved at startup. */
  secrets?: Record<string, string>;
  /** Allowlisted URL patterns (glob). A request must match at least one pattern
   *  in this route's list to use this route. Empty = matches nothing. */
  allowedEndpoints: string[];
  /** Whether to resolve ${VAR} placeholders in request bodies.
   *  Defaults to false — prevents agents from exfiltrating secrets by
   *  writing placeholder strings into API resources and reading them back. */
  resolveSecretsInBody?: boolean;
  /** Optional ingestor configuration for real-time event ingestion.
   *  When present, the remote server can start a long-lived ingestor
   *  (WebSocket, webhook listener, or poller) for this connection. */
  ingestor?: IngestorConfig;
}

/** A route after secret/header resolution — used at runtime */
export interface ResolvedRoute {
  /** Human-readable name for this route (carried from config) */
  name?: string;
  /** Short description of this route's purpose (carried from config) */
  description?: string;
  /** Link to API documentation for the service behind this route (carried from config) */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec for this route's API (carried from config) */
  openApiUrl?: string;
  headers: Record<string, string>;
  secrets: Record<string, string>;
  allowedEndpoints: string[];
  /** Whether to resolve ${VAR} placeholders in request bodies (default: false) */
  resolveSecretsInBody: boolean;
}

/** Per-connection ingestor overrides (all fields optional — omitted fields inherit from template). */
export interface IngestorOverrides {
  /** Override the Discord Gateway intents bitmask. */
  intents?: number;
  /** Override event type filter (e.g., ["MESSAGE_CREATE"]). Empty array = capture all. */
  eventFilter?: string[];
  /** Only buffer events from these guild IDs. Omitted = all guilds. */
  guildIds?: string[];
  /** Only buffer events from these channel IDs. Omitted = all channels. */
  channelIds?: string[];
  /** Only buffer events from these user IDs. Omitted = all users. */
  userIds?: string[];
  /** Override ring buffer capacity. */
  bufferSize?: number;
  /** Disable the ingestor for this connection entirely. */
  disabled?: boolean;
  /** Override the poll interval in milliseconds (poll ingestors only). */
  intervalMs?: number;
}

/** Per-caller access configuration */
export interface CallerConfig {
  /** Human-readable name for this caller (used in audit logs) */
  name?: string;
  /** Path to this caller's public key files (signing.pub.pem + exchange.pub.pem) */
  peerKeyDir: string;
  /** List of connection aliases — references built-in templates (e.g., "github")
   *  or custom connector aliases defined in the top-level connectors array. */
  connections: string[];
  /** Per-caller environment variable overrides.
   *  Keys = env var names that connectors reference (e.g., "GITHUB_TOKEN").
   *  Values = "${REAL_ENV_VAR}" (redirect to a different env var) or a literal string (direct injection).
   *  These are resolved first, then checked BEFORE process.env during secret resolution. */
  env?: Record<string, string>;
  /** Per-connection ingestor overrides. Keys are connection aliases (e.g., "discord-bot").
   *  Allows callers to customize intents, event filters, guild/channel/user ID filters,
   *  buffer size, or disable an ingestor without modifying the connection template. */
  ingestorOverrides?: Record<string, IngestorOverrides>;
}

/** Remote server configuration */
export interface RemoteServerConfig {
  /** Host to bind to */
  host: string;
  /** Port to listen on */
  port: number;
  /** Path to our own key bundle */
  localKeysDir: string;
  /** Custom connector definitions — a reusable pool referenced by alias from callers.
   *  Each connector scopes secrets and headers to endpoint patterns. */
  connectors?: Route[];
  /** Per-caller access control. Keys are caller aliases (used in audit logs).
   *  Each caller specifies their peer key directory and which connections they can use. */
  callers: Record<string, CallerConfig>;
  /** Rate limit: max requests per minute per session */
  rateLimitPerMinute: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

function proxyDefaults(): ProxyConfig {
  return {
    remoteUrl: 'http://localhost:9999',
    localKeysDir: path.join(getLocalKeysDir(), 'default'),
    remotePublicKeysDir: path.join(getPeerKeysDir(), 'remote-server'),
    connectTimeout: 10_000,
    requestTimeout: 30_000,
  };
}

function remoteDefaults(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 9999,
    localKeysDir: getRemoteKeysDir(),
    callers: {},
    rateLimitPerMinute: 60,
  };
}

// ── Split config loading (preferred) ─────────────────────────────────────────

/**
 * Load the MCP proxy (local) config.
 *
 * Resolution order:
 *   1. proxy.config.json (flat ProxyConfig)
 *   2. config.json → .proxy section (legacy combined format)
 *   3. Built-in defaults
 *
 * Key alias resolution (applied after loading):
 *   1. MCP_KEY_ALIAS env var (highest — set per agent at spawn time)
 *   2. localKeyAlias in config file
 *   3. localKeysDir in config file (explicit full path)
 *   4. Default: keys/local/default
 */
export function loadProxyConfig(): ProxyConfig {
  const def = proxyDefaults();

  let config: ProxyConfig;

  // Try dedicated proxy config file first
  if (fs.existsSync(getProxyConfigPath())) {
    const raw = JSON.parse(fs.readFileSync(getProxyConfigPath(), 'utf-8'));
    config = { ...def, ...raw };
  } else if (fs.existsSync(getConfigPath())) {
    // Fall back to combined config.json
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    config = raw.proxy ? { ...def, ...raw.proxy } : def;
  } else {
    config = def;
  }

  // Alias resolution: env var > config alias > localKeysDir > default
  const envAlias = process.env.MCP_KEY_ALIAS?.trim() || undefined;
  const alias = envAlias ?? config.localKeyAlias;

  if (alias) {
    config.localKeysDir = path.join(getLocalKeysDir(), alias);
  }

  return config;
}

/**
 * Load the remote server config.
 *
 * Resolution order:
 *   1. remote.config.json (flat RemoteServerConfig)
 *   2. config.json → .remote section (legacy combined format)
 *   3. Built-in defaults
 *
 * Legacy configs with `routes`/`authorizedPeersDir`/`connections` are auto-migrated
 * to the caller-centric format with a deprecation warning.
 */
export function loadRemoteConfig(): RemoteServerConfig {
  const def = remoteDefaults();

  let config: RemoteServerConfig;

  // Try dedicated remote config file first
  if (fs.existsSync(getRemoteConfigPath())) {
    const raw = JSON.parse(fs.readFileSync(getRemoteConfigPath(), 'utf-8'));
    config = { ...def, ...raw };
  } else if (fs.existsSync(getConfigPath())) {
    // Fall back to combined config.json
    const raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    config = raw.remote ? { ...def, ...raw.remote } : def;
  } else {
    config = def;
  }

  // Legacy migration: old format had routes/authorizedPeersDir/connections at top level
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading unknown legacy config shape
  const rawConfig = config as any;
  if (rawConfig.routes && !config.callers?.default && !rawConfig.connectors) {
    console.error(
      '[config] Warning: legacy config format detected (routes/authorizedPeersDir/connections). ' +
        'Migrating to caller-centric format. Please update your remote.config.json.',
    );

    const legacyRoutes: Route[] = rawConfig.routes;
    const legacyConnections: string[] = rawConfig.connections ?? [];
    const legacyPeersDir: string =
      rawConfig.authorizedPeersDir ?? path.join(getPeerKeysDir(), 'authorized-clients');

    // Auto-assign aliases to unnamed routes for the default caller
    const connectors = legacyRoutes.map((r, i) => ({
      ...r,
      alias: r.alias ?? r.name?.toLowerCase().replace(/\s+/g, '-') ?? `route-${i}`,
    }));

    const allConnectionNames = [...legacyConnections, ...connectors.map((c) => c.alias!)];

    config = {
      ...def,
      host: config.host,
      port: config.port,
      localKeysDir: config.localKeysDir,
      connectors,
      callers: {
        default: {
          peerKeyDir: legacyPeersDir,
          connections: allConnectionNames,
        },
      },
      rateLimitPerMinute: config.rateLimitPerMinute,
    };
  }

  return config;
}

// ── Split config saving ─────────────────────────────────────────────────────

export function saveProxyConfig(config: ProxyConfig): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(getProxyConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function saveRemoteConfig(config: RemoteServerConfig): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(getRemoteConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Per-caller route resolution ──────────────────────────────────────────

/**
 * Resolve the effective routes for a specific caller.
 *
 * For each connection name in the caller's `connections` list:
 *   1. Check custom connectors (by alias) first
 *   2. Fall back to built-in connection templates (e.g., "github", "stripe")
 *
 * Returns an array of Route objects ready for `resolveRoutes()`.
 */
export function resolveCallerRoutes(config: RemoteServerConfig, callerAlias: string): Route[] {
  const caller = config.callers[callerAlias];
  if (!caller) return [];

  // Build lookup map for custom connectors by alias
  const connectorsByAlias = new Map<string, Route>();
  for (const c of config.connectors ?? []) {
    if (c.alias) connectorsByAlias.set(c.alias, c);
  }

  return caller.connections.map((name) => {
    // Custom connectors take precedence over built-in templates
    const custom = connectorsByAlias.get(name);
    if (custom) return custom;
    return loadConnection(name);
  });
}

// ── Secret / placeholder resolution ──────────────────────────────────────────

/**
 * Replace ${VAR} placeholders in a string with values from a secrets map.
 * Unknown placeholders are left unchanged (with a warning).
 */
export function resolvePlaceholders(str: string, secretsMap: Record<string, string>): string {
  return str.replace(/\$\{(\w+)\}/g, (match, name: string) => {
    if (name in secretsMap) return secretsMap[name];
    console.error(`[config] Warning: placeholder ${match} not found in secrets`);
    return match;
  });
}

/**
 * Load secrets from the config's secrets map, resolving from environment
 * variables. Value can be a literal string or "${VAR_NAME}" to read from env.
 *
 * When `envOverrides` is provided (pre-resolved caller env map), those values
 * are checked BEFORE process.env, allowing per-caller secret redirection.
 */
export function resolveSecrets(
  secretsMap: Record<string, string>,
  envOverrides?: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretsMap)) {
    const envMatch = /^\$\{(.+)\}$/.exec(value);
    if (envMatch) {
      const varName = envMatch[1];
      const envVal = envOverrides?.[varName] ?? process.env[varName];
      if (envVal !== undefined) {
        resolved[key] = envVal;
      } else {
        console.error(`[secrets] Warning: env var ${varName} not found for key ${key}`);
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve all routes: resolve secrets from env vars, then resolve header
 * placeholders against each route's own resolved secrets.
 *
 * When `envOverrides` is provided, those pre-resolved values are checked
 * before process.env during secret resolution (used for per-caller env).
 */
export function resolveRoutes(
  routes: Route[],
  envOverrides?: Record<string, string>,
): ResolvedRoute[] {
  return routes.map((route) => {
    const resolvedSecrets = resolveSecrets(route.secrets ?? {}, envOverrides);
    const resolvedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      resolvedHeaders[key] = resolvePlaceholders(value, resolvedSecrets);
    }
    return {
      ...(route.name !== undefined && { name: route.name }),
      ...(route.description !== undefined && { description: route.description }),
      ...(route.docsUrl !== undefined && { docsUrl: route.docsUrl }),
      ...(route.openApiUrl !== undefined && { openApiUrl: route.openApiUrl }),
      headers: resolvedHeaders,
      secrets: resolvedSecrets,
      allowedEndpoints: route.allowedEndpoints,
      resolveSecretsInBody: route.resolveSecretsInBody ?? false,
    };
  });
}
