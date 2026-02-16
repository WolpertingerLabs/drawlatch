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
import { loadConnection } from './connections.js';
/** Base directory for all config and keys.
 *  Defaults to .mcp-secure-proxy/ in the current working directory (repo-local).
 *  Override with MCP_CONFIG_DIR env var for custom deployments. */
export const CONFIG_DIR = process.env.MCP_CONFIG_DIR ?? path.join(process.cwd(), '.mcp-secure-proxy');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const PROXY_CONFIG_PATH = path.join(CONFIG_DIR, 'proxy.config.json');
export const REMOTE_CONFIG_PATH = path.join(CONFIG_DIR, 'remote.config.json');
export const KEYS_DIR = path.join(CONFIG_DIR, 'keys');
export const LOCAL_KEYS_DIR = path.join(KEYS_DIR, 'local');
export const REMOTE_KEYS_DIR = path.join(KEYS_DIR, 'remote');
export const PEER_KEYS_DIR = path.join(KEYS_DIR, 'peers');
// ── Defaults ─────────────────────────────────────────────────────────────────
function proxyDefaults() {
    return {
        remoteUrl: 'http://localhost:9999',
        localKeysDir: LOCAL_KEYS_DIR,
        remotePublicKeysDir: path.join(PEER_KEYS_DIR, 'remote-server'),
        connectTimeout: 10_000,
        requestTimeout: 30_000,
    };
}
function remoteDefaults() {
    return {
        host: '127.0.0.1',
        port: 9999,
        localKeysDir: REMOTE_KEYS_DIR,
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
 */
export function loadProxyConfig() {
    const def = proxyDefaults();
    // Try dedicated proxy config file first
    if (fs.existsSync(PROXY_CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(PROXY_CONFIG_PATH, 'utf-8'));
        return { ...def, ...raw };
    }
    // Fall back to combined config.json
    if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (raw.proxy)
            return { ...def, ...raw.proxy };
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
 *
 * Legacy configs with `routes`/`authorizedPeersDir`/`connections` are auto-migrated
 * to the caller-centric format with a deprecation warning.
 */
export function loadRemoteConfig() {
    const def = remoteDefaults();
    let config;
    // Try dedicated remote config file first
    if (fs.existsSync(REMOTE_CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(REMOTE_CONFIG_PATH, 'utf-8'));
        config = { ...def, ...raw };
    }
    else if (fs.existsSync(CONFIG_PATH)) {
        // Fall back to combined config.json
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        config = raw.remote ? { ...def, ...raw.remote } : def;
    }
    else {
        config = def;
    }
    // Legacy migration: old format had routes/authorizedPeersDir/connections at top level
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading unknown legacy config shape
    const rawConfig = config;
    if (rawConfig.routes && !config.callers?.default && !rawConfig.connectors) {
        console.error('[config] Warning: legacy config format detected (routes/authorizedPeersDir/connections). ' +
            'Migrating to caller-centric format. Please update your remote.config.json.');
        const legacyRoutes = rawConfig.routes;
        const legacyConnections = rawConfig.connections ?? [];
        const legacyPeersDir = rawConfig.authorizedPeersDir ?? path.join(PEER_KEYS_DIR, 'authorized-clients');
        // Auto-assign aliases to unnamed routes for the default caller
        const connectors = legacyRoutes.map((r, i) => ({
            ...r,
            alias: r.alias ?? r.name?.toLowerCase().replace(/\s+/g, '-') ?? `route-${i}`,
        }));
        const allConnectionNames = [
            ...legacyConnections,
            ...connectors.map((c) => c.alias),
        ];
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
export function saveProxyConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
export function saveRemoteConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(REMOTE_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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
export function resolveCallerRoutes(config, callerAlias) {
    const caller = config.callers[callerAlias];
    if (!caller)
        return [];
    // Build lookup map for custom connectors by alias
    const connectorsByAlias = new Map();
    for (const c of config.connectors ?? []) {
        if (c.alias)
            connectorsByAlias.set(c.alias, c);
    }
    return caller.connections.map((name) => {
        // Custom connectors take precedence over built-in templates
        const custom = connectorsByAlias.get(name);
        if (custom)
            return custom;
        return loadConnection(name);
    });
}
// ── Secret / placeholder resolution ──────────────────────────────────────────
/**
 * Replace ${VAR} placeholders in a string with values from a secrets map.
 * Unknown placeholders are left unchanged (with a warning).
 */
export function resolvePlaceholders(str, secretsMap) {
    return str.replace(/\$\{(\w+)\}/g, (match, name) => {
        if (name in secretsMap)
            return secretsMap[name];
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
export function resolveSecrets(secretsMap, envOverrides) {
    const resolved = {};
    for (const [key, value] of Object.entries(secretsMap)) {
        const envMatch = /^\$\{(.+)\}$/.exec(value);
        if (envMatch) {
            const varName = envMatch[1];
            const envVal = envOverrides?.[varName] ?? process.env[varName];
            if (envVal !== undefined) {
                resolved[key] = envVal;
            }
            else {
                console.error(`[secrets] Warning: env var ${varName} not found for key ${key}`);
            }
        }
        else {
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
export function resolveRoutes(routes, envOverrides) {
    return routes.map((route) => {
        const resolvedSecrets = resolveSecrets(route.secrets ?? {}, envOverrides);
        const resolvedHeaders = {};
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
//# sourceMappingURL=config.js.map