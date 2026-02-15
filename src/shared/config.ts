/**
 * Configuration schema and loading for both MCP proxy and remote server.
 *
 * Config file: ~/.mcp-secure-proxy/config.json
 * Keys directory: ~/.mcp-secure-proxy/keys/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Base directory for all config and keys.
 *  Defaults to .mcp-secure-proxy/ in the current working directory (repo-local).
 *  Override with MCP_CONFIG_DIR env var for custom deployments. */
export const CONFIG_DIR = process.env.MCP_CONFIG_DIR || path.join(process.cwd(), '.mcp-secure-proxy');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
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

/** Full config file */
export interface Config {
  proxy: ProxyConfig;
  remote: RemoteServerConfig;
}

function defaults(): Config {
  return {
    proxy: {
      remoteUrl: 'http://localhost:9999',
      localKeysDir: LOCAL_KEYS_DIR,
      remotePublicKeysDir: path.join(PEER_KEYS_DIR, 'remote-server'),
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    },
    remote: {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: REMOTE_KEYS_DIR,
      authorizedPeersDir: path.join(PEER_KEYS_DIR, 'authorized-clients'),
      routes: [],
      rateLimitPerMinute: 60,
    },
  };
}

export function loadConfig(): Config {
  const def = defaults();
  if (!fs.existsSync(CONFIG_PATH)) {
    return def;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return {
    proxy: { ...def.proxy, ...raw.proxy },
    remote: { ...def.remote, ...raw.remote },
  };
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

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
      headers: resolvedHeaders,
      secrets: resolvedSecrets,
      allowedEndpoints: route.allowedEndpoints,
    };
  });
}
