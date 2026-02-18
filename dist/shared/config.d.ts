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
import type { IngestorConfig } from '../remote/ingestors/types.js';
/** Base directory for all config and keys.
 *  Defaults to .mcp-secure-proxy/ in the current working directory (repo-local).
 *  Override with MCP_CONFIG_DIR env var for custom deployments. */
export declare const CONFIG_DIR: string;
export declare const CONFIG_PATH: string;
export declare const PROXY_CONFIG_PATH: string;
export declare const REMOTE_CONFIG_PATH: string;
export declare const KEYS_DIR: string;
export declare const LOCAL_KEYS_DIR: string;
export declare const REMOTE_KEYS_DIR: string;
export declare const PEER_KEYS_DIR: string;
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
/**
 * Load the MCP proxy (local) config.
 *
 * Resolution order:
 *   1. proxy.config.json (flat ProxyConfig)
 *   2. config.json → .proxy section (legacy combined format)
 *   3. Built-in defaults
 */
export declare function loadProxyConfig(): ProxyConfig;
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
export declare function loadRemoteConfig(): RemoteServerConfig;
export declare function saveProxyConfig(config: ProxyConfig): void;
export declare function saveRemoteConfig(config: RemoteServerConfig): void;
/**
 * Resolve the effective routes for a specific caller.
 *
 * For each connection name in the caller's `connections` list:
 *   1. Check custom connectors (by alias) first
 *   2. Fall back to built-in connection templates (e.g., "github", "stripe")
 *
 * Returns an array of Route objects ready for `resolveRoutes()`.
 */
export declare function resolveCallerRoutes(config: RemoteServerConfig, callerAlias: string): Route[];
/**
 * Replace ${VAR} placeholders in a string with values from a secrets map.
 * Unknown placeholders are left unchanged (with a warning).
 */
export declare function resolvePlaceholders(str: string, secretsMap: Record<string, string>): string;
/**
 * Load secrets from the config's secrets map, resolving from environment
 * variables. Value can be a literal string or "${VAR_NAME}" to read from env.
 *
 * When `envOverrides` is provided (pre-resolved caller env map), those values
 * are checked BEFORE process.env, allowing per-caller secret redirection.
 */
export declare function resolveSecrets(secretsMap: Record<string, string>, envOverrides?: Record<string, string>): Record<string, string>;
/**
 * Resolve all routes: resolve secrets from env vars, then resolve header
 * placeholders against each route's own resolved secrets.
 *
 * When `envOverrides` is provided, those pre-resolved values are checked
 * before process.env during secret resolution (used for per-caller env).
 */
export declare function resolveRoutes(routes: Route[], envOverrides?: Record<string, string>): ResolvedRoute[];
//# sourceMappingURL=config.d.ts.map