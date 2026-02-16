/**
 * Configuration schema and loading for both MCP proxy and remote server.
 *
 * Config file: ~/.mcp-secure-proxy/config.json
 * Keys directory: ~/.mcp-secure-proxy/keys/
 */
/** Base directory for all config and keys */
export declare const CONFIG_DIR: string;
export declare const CONFIG_PATH: string;
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
    /** Secrets configuration — env vars to inject */
    secrets: Record<string, string>;
    /** Allowlisted URL patterns for API proxying */
    allowedEndpoints: string[];
    /** Rate limit: max requests per minute per session */
    rateLimitPerMinute: number;
}
/** Full config file */
export interface Config {
    proxy: ProxyConfig;
    remote: RemoteServerConfig;
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
/**
 * Load secrets from the config's secrets map, resolving from environment
 * variables. Value can be a literal string or "${VAR_NAME}" to read from env.
 */
export declare function resolveSecrets(secretsMap: Record<string, string>): Record<string, string>;
//# sourceMappingURL=config.d.ts.map