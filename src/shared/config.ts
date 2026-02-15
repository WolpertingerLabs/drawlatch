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
 * Keys directory: .mcp-secure-proxy/keys/
 */

import fs from 'node:fs';
import path from 'node:path';

/** Base directory for all config and keys.
 *  Defaults to .mcp-secure-proxy/ in the current working directory (repo-local).
 *  Override with MCP_CONFIG_DIR env var for custom deployments. */
export const CONFIG_DIR =
  process.env.MCP_CONFIG_DIR ?? path.join(process.cwd(), '.mcp-secure-proxy');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const PROXY_CONFIG_PATH = path.join(CONFIG_DIR, 'proxy.config.json');
export const REMOTE_CONFIG_PATH = path.join(CONFIG_DIR, 'remote.config.json');
export const KEYS_DIR = path.join(CONFIG_DIR, 'keys');
export const LOCAL_KEYS_DIR = path.join(KEYS_DIR, 'local');
export const REMOTE_KEYS_DIR = path.join(KEYS_DIR, 'remote');
export const PEER_KEYS_DIR = path.join(KEYS_DIR, 'peers');

/** MCP proxy (local) configuration */
export interface ProxyConfig {
  /** Remote server URL */
  remoteUrl: string;
  /** Path to our own key bundle */
  localKeysDir: string;
  /** Path to the remote server's public keys */
  remotePublicKeysDir: string;
  /** Connection timeout (ms) */
  connectTimeout: number;
  /** Request timeout (ms) */
  requestTimeout: number;
}

/** A single route definition — scopes secrets and headers to a set of endpoints */
export interface Route {
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
   *  Optional — when present, get_route_docs will fetch this instead of docsUrl
   *  for more structured, agent-friendly documentation. */
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
}

/** Remote server configuration */
export interface RemoteServerConfig {
  /** Host to bind to */
  host: string;
  /** Port to listen on */
  port: number;
  /** Path to our own key bundle */
  localKeysDir: string;
  /** Directory containing authorized peer public keys (one subdir per peer) */
  authorizedPeersDir: string;
  /** Route definitions — each scopes secrets and headers to endpoint patterns */
  routes: Route[];
  /** Rate limit: max requests per minute per session */
  rateLimitPerMinute: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

function proxyDefaults(): ProxyConfig {
  return {
    remoteUrl: 'http://localhost:9999',
    localKeysDir: LOCAL_KEYS_DIR,
    remotePublicKeysDir: path.join(PEER_KEYS_DIR, 'remote-server'),
    connectTimeout: 10_000,
    requestTimeout: 30_000,
  };
}

function remoteDefaults(): RemoteServerConfig {
  return {
    host: '127.0.0.1',
    port: 9999,
    localKeysDir: REMOTE_KEYS_DIR,
    authorizedPeersDir: path.join(PEER_KEYS_DIR, 'authorized-clients'),
    routes: [],
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
 */
export function loadProxyConfig(): ProxyConfig {
  const def = proxyDefaults();

  // Try dedicated proxy config file first
  if (fs.existsSync(PROXY_CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf-8'));
    return { ...def, ...raw };
  }

  // Fall back to combined config.json
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (raw.proxy) return { ...def, ...raw.proxy };
  }

  return def;
}

/**
 * Load the remote server config.
 *
 * Resolution order:
 *   1. remote.config.json (flat RemoteServerConfig)
 *   2. config.json → .remote section (legacy combined format)
 *   3. Built-in defaults
 */
export function loadRemoteConfig(): RemoteServerConfig {
  const def = remoteDefaults();

  // Try dedicated remote config file first
  if (fs.existsSync(REMOTE_CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(REMOTE_CONFIG_PATH, 'utf-8'));
    return { ...def, ...raw };
  }

  // Fall back to combined config.json
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (raw.remote) return { ...def, ...raw.remote };
  }

  return def;
}

// ── Split config saving ─────────────────────────────────────────────────────

export function saveProxyConfig(config: ProxyConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function saveRemoteConfig(config: RemoteServerConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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
 */
export function resolveSecrets(secretsMap: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(secretsMap)) {
    const envMatch = /^\$\{(.+)\}$/.exec(value);
    if (envMatch) {
      const envVal = process.env[envMatch[1]];
      if (envVal !== undefined) {
        resolved[key] = envVal;
      } else {
        console.error(`[secrets] Warning: env var ${envMatch[1]} not found for key ${key}`);
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
 */
export function resolveRoutes(routes: Route[]): ResolvedRoute[] {
  return routes.map((route) => {
    const resolvedSecrets = resolveSecrets(route.secrets ?? {});
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
    };
  });
}
