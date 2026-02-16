/**
 * Configuration schema and loading for both MCP proxy and remote server.
 *
 * Config file: ~/.mcp-secure-proxy/config.json
 * Keys directory: ~/.mcp-secure-proxy/keys/
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/** Base directory for all config and keys */
export const CONFIG_DIR = path.join(os.homedir(), '.mcp-secure-proxy');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const KEYS_DIR = path.join(CONFIG_DIR, 'keys');
export const LOCAL_KEYS_DIR = path.join(KEYS_DIR, 'local');
export const REMOTE_KEYS_DIR = path.join(KEYS_DIR, 'remote');
export const PEER_KEYS_DIR = path.join(KEYS_DIR, 'peers');
function defaults() {
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
            secrets: {},
            allowedEndpoints: [],
            rateLimitPerMinute: 60,
        },
    };
}
export function loadConfig() {
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
export function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
/**
 * Load secrets from the config's secrets map, resolving from environment
 * variables. Value can be a literal string or "${VAR_NAME}" to read from env.
 */
export function resolveSecrets(secretsMap) {
    const resolved = {};
    for (const [key, value] of Object.entries(secretsMap)) {
        const envMatch = value.match(/^\$\{(.+)\}$/);
        if (envMatch) {
            const envVal = process.env[envMatch[1]];
            if (envVal !== undefined) {
                resolved[key] = envVal;
            }
            else {
                console.error(`[secrets] Warning: env var ${envMatch[1]} not found for key ${key}`);
            }
        }
        else {
            resolved[key] = value;
        }
    }
    return resolved;
}
//# sourceMappingURL=config.js.map