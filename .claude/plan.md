# Plan: Support Packaging with claude-code-ui + Admin API + In-Process Local Mode

## Overview

Changes needed in mcp-secure-proxy to support tight integration with claude-code-ui:
1. **Package exports** — expose core logic functions for in-process consumption (no server needed for local mode)
2. **Admin API** — new authenticated tool handlers for remote caller/connection/secret management
3. **Bootstrap** — programmatic first-run initialization for claude-code-ui's setup wizard
4. **Connection introspection** — expose template metadata so the UI knows what secrets each connection needs

---

## Part 1: Package Exports for External Consumption

### Problem

claude-code-ui currently vendors a copy of the crypto/handshake/channel code in `proxy-client.ts`. Once mcp-secure-proxy is added as a dependency (via `file:` ref now, published npm package later), claude-code-ui should import directly from the package instead.

For **local mode**, claude-code-ui runs the core proxy logic in-process — it needs to import the pure functions (route matching, secret resolution, endpoint checking) and the `IngestorManager` directly. No server, no encryption, no HTTP.

For **remote mode**, claude-code-ui still uses `ProxyClient` with encryption over HTTP — it needs the handshake/channel/protocol exports.

### Solution: Add `exports` map to `package.json`

```json
{
  "exports": {
    ".": "./dist/mcp/server.js",
    "./shared/crypto": "./dist/shared/crypto/index.js",
    "./shared/protocol": "./dist/shared/protocol/index.js",
    "./shared/config": "./dist/shared/config.js",
    "./shared/connections": "./dist/shared/connections.js",
    "./remote/server": "./dist/remote/server.js",
    "./remote/ingestors": "./dist/remote/ingestors/index.js",
    "./bootstrap": "./dist/cli/bootstrap.js",
    "./cli/generate-keys": "./dist/cli/generate-keys.js"
  }
}
```

### Required Re-exports

Ensure `src/shared/crypto/index.ts` exports everything claude-code-ui needs:

```typescript
// Already exported (verify):
export { generateKeyBundle, saveKeyBundle, loadKeyBundle, loadPublicKeys,
         extractPublicKeys, fingerprint } from './keys.js';
export { EncryptedChannel } from './channel.js';
export type { KeyBundle, PublicKeyBundle, SessionKeys } from './keys.js';
```

Ensure `src/shared/protocol/index.ts` exports:
```typescript
export { HandshakeInitiator, HandshakeResponder } from './handshake.js';
export type { HandshakeInit, HandshakeFinish, HandshakeReply,
             ProxyRequest, ProxyResponse } from './handshake.js';
```

Ensure `src/remote/server.ts` exports the core logic functions (these are used directly by `LocalProxy` in claude-code-ui):
```typescript
// Already exported (verify):
export { matchRoute, isEndpointAllowed, resolvePlaceholders };
// May need to add explicit exports if only used internally today
```

Ensure `src/shared/config.ts` exports:
```typescript
export {
  loadRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  resolvePlaceholders,
  CONFIG_DIR, KEYS_DIR, LOCAL_KEYS_DIR, REMOTE_KEYS_DIR, PEER_KEYS_DIR,
};
export type {
  ProxyConfig, RemoteServerConfig, CallerConfig, Route,
  ResolvedRoute, IngestorOverrides,
};
```

Ensure `src/remote/ingestors/index.ts` exports:
```typescript
export { IngestorManager } from './manager.js';
export type { IngestorConfig, IngestedEvent } from './types.js';
```

### Files to Change

| File | Change |
|------|--------|
| `package.json` | Add `exports` map |
| `src/shared/crypto/index.ts` | Verify all necessary exports exist |
| `src/shared/protocol/index.ts` | Verify all necessary exports exist |
| `src/shared/config.ts` | Verify config helpers are exported |
| `src/remote/server.ts` | Verify `matchRoute`, `isEndpointAllowed` are exported |
| `src/remote/ingestors/index.ts` | Verify `IngestorManager` export |
| `tsconfig.json` | Ensure `declaration: true` for type exports |

---

## Part 2: Admin API — Authenticated Management Tools

### Concept

Add a new set of "admin" tool handlers to the remote server that allow an authorized caller (with admin role) to manage callers, connections, and secrets. These are invoked through the same encrypted channel as regular tools — no new HTTP endpoints needed.

Note: The Admin API is only used in **remote mode**. In local mode, claude-code-ui manages config files directly.

### Caller Roles

Extend `CallerConfig` with an optional `role` field:

```typescript
// In src/shared/config.ts
export interface CallerConfig {
  name?: string;
  peerKeyDir: string;
  connections: string[];
  env?: Record<string, string>;
  ingestorOverrides?: Record<string, IngestorOverrides>;

  /** Caller role. "admin" grants access to management tools.
   *  Default: "user" (standard tool access only). */
  role?: 'admin' | 'user';
}
```

Admin callers gain access to additional tool handlers (below). Regular callers cannot invoke admin tools — the handler checks the role and rejects unauthorized requests.

### New Tool Handlers

Add to `src/remote/server.ts` (or extract to `src/remote/admin-handlers.ts`):

#### 1. `admin_register_caller`

Register a new caller by providing their public keys and connection list.

```typescript
async admin_register_caller(input, routes, context) {
  assertAdmin(context);

  const { callerAlias, name, signingPubPem, exchangePubPem, connections } = input as {
    callerAlias: string;
    name?: string;
    signingPubPem: string;   // PEM-encoded Ed25519 public key
    exchangePubPem: string;  // PEM-encoded X25519 public key
    connections: string[];
  };

  // 1. Validate alias doesn't already exist
  // 2. Write public keys to keys/peers/{callerAlias}/
  //    - signing.pub.pem
  //    - exchange.pub.pem
  // 3. Add caller entry to remote.config.json:
  //    callers[callerAlias] = { name, peerKeyDir, connections, env: {} }
  // 4. Return { success: true, callerAlias, fingerprint, restartRequired: true }
}
```

#### 2. `admin_remove_caller`

Remove a caller's authorization.

```typescript
async admin_remove_caller(input, routes, context) {
  assertAdmin(context);

  const { callerAlias } = input as { callerAlias: string };

  // 1. Validate caller exists (prevent removing self)
  // 2. Remove from remote.config.json
  // 3. Delete keys/peers/{callerAlias}/ directory
  // 4. Return { success: true, restartRequired: true }
  //    (claude-code-ui restarts the server to pick up changes)
}
```

#### 3. `admin_update_caller_connections`

Enable or disable connections for a caller.

```typescript
async admin_update_caller_connections(input, routes, context) {
  assertAdmin(context);

  const { callerAlias, connections } = input as {
    callerAlias: string;
    connections: string[];  // New full connection list (replaces existing)
  };

  // 1. Load config
  // 2. Update callers[callerAlias].connections = connections
  // 3. Save config
  // 4. Return { success: true, connections, restartRequired: true }
}
```

#### 4. `admin_set_secrets`

Set or update environment variable secrets for a caller's connections.

```typescript
async admin_set_secrets(input, routes, context) {
  assertAdmin(context);

  const { callerAlias, connectionAlias, secrets } = input as {
    callerAlias: string;
    connectionAlias: string;
    secrets: Record<string, string>;  // { "DISCORD_BOT_TOKEN": "abc123" }
  };

  // 1. Validate caller exists and has this connection enabled
  // 2. For each secret:
  //    a. Generate env var name: `${CALLER}_${SECRET}` (e.g., AGENT1_DISCORD_BOT_TOKEN)
  //    b. Write to .env file (or secrets store)
  //    c. Update caller.env mapping: { "DISCORD_BOT_TOKEN": "${AGENT1_DISCORD_BOT_TOKEN}" }
  // 3. Save .env and remote.config.json
  // 4. Return { success: true, secretsSet: Object.keys(secrets), restartRequired: true }
}
```

#### 5. `admin_get_secret_status`

Check which secrets are configured (returns names only, never values).

```typescript
async admin_get_secret_status(input, routes, context) {
  assertAdmin(context);

  const { callerAlias, connectionAlias } = input as {
    callerAlias: string;
    connectionAlias?: string;  // If omitted, returns status for all connections
  };

  // 1. Load connection template(s) to get required secret names
  // 2. Check which env vars are set (via caller.env mapping → .env file)
  // 3. Return { secrets: { "DISCORD_BOT_TOKEN": true, "WEBHOOK_SECRET": false } }
}
```

#### 6. `admin_list_callers`

List all registered callers and their connections.

```typescript
async admin_list_callers(input, routes, context) {
  assertAdmin(context);

  // 1. Load remote.config.json
  // 2. Return summary for each caller:
  //    { alias, name, connections, role, fingerprint (from their public keys) }
}
```

#### 7. `admin_list_connection_templates`

List all available connection templates (built-in + custom connectors).

```typescript
async admin_list_connection_templates(input, routes, context) {
  assertAdmin(context);

  // 1. Load all built-in templates from src/connections/*.json
  // 2. Load custom connectors from remote.config.json
  // 3. Return: [{ alias, name, description, docsUrl, requiredSecrets, hasIngestor, ingestorType }]
}
```

### Admin Role Guard

```typescript
// src/remote/admin-handlers.ts

function assertAdmin(context: ToolContext): void {
  const config = loadRemoteConfig();
  const caller = config.callers[context.callerAlias];
  if (!caller || caller.role !== 'admin') {
    throw new Error(`Caller "${context.callerAlias}" is not authorized for admin operations`);
  }
}
```

### Tool Registration

The admin tools need to be registered in the `toolHandlers` map. Guard each with `assertAdmin()`:

```typescript
// In server.ts or imported from admin-handlers.ts
const toolHandlers: Record<string, ToolHandler> = {
  // ... existing handlers (http_request, list_routes, poll_events, ingestor_status)

  admin_register_caller: adminHandlers.registerCaller,
  admin_remove_caller: adminHandlers.removeCaller,
  admin_update_caller_connections: adminHandlers.updateCallerConnections,
  admin_set_secrets: adminHandlers.setSecrets,
  admin_get_secret_status: adminHandlers.getSecretStatus,
  admin_list_callers: adminHandlers.listCallers,
  admin_list_connection_templates: adminHandlers.listConnectionTemplates,
};
```

### MCP Tool Definitions Update

The local MCP proxy (`src/mcp/server.ts`) needs to expose the admin tools so Claude Code (or claude-code-ui's ProxyClient) can call them. However, the MCP proxy should only list admin tools if the caller actually has admin role. Two options:

**Option A (simpler):** Always list admin tools in MCP, let the remote server reject unauthorized calls.

**Option B (cleaner):** Add a `list_tools` call during handshake that returns available tools for this caller (including admin tools if admin). The MCP proxy dynamically registers tools based on the response.

**Recommendation:** Option A for initial implementation, migrate to Option B later. The error message from `assertAdmin()` is clear enough.

### Note: MCP Server Usage in Local vs. Remote Mode

**Remote mode (standalone):** The MCP server in `src/mcp/server.ts` continues to function as before — a stdio process that Claude Code or other MCP clients connect to. It performs cryptographic handshake with the remote server and proxies tool calls over the encrypted channel.

**Local mode (via claude-code-ui):** The `src/mcp/server.ts` stdio MCP server is **not used**. Instead, claude-code-ui builds an in-process SDK-based MCP server (`proxy-tools.ts`) that exposes the same tool interface (`secure_request`, `list_routes`, `poll_events`, `ingestor_status`) and injects it into every chat session. The tools call `LocalProxy` directly — no separate process, no encryption. This ensures proxy tools are available in ALL chat sessions (not just agent sessions).

The core functions exported from this package (`matchRoute`, `isEndpointAllowed`, `resolvePlaceholders`, `IngestorManager`, etc.) are what make this in-process approach possible — see Part 1.

---

## Part 3: .env File Management

### Problem

Admin tools need to programmatically read/write `.env` files. Currently `.env` is loaded once at startup via `dotenv/config`.

### Solution: Structured .env Manager

New file: `src/remote/env-manager.ts`

```typescript
import { parse, stringify } from './env-parser.js';

export class EnvManager {
  private envPath: string;

  constructor(configDir: string) {
    this.envPath = join(configDir, '.env');
  }

  /** Read all env vars from .env file */
  readAll(): Record<string, string> {
    if (!existsSync(this.envPath)) return {};
    return parse(readFileSync(this.envPath, 'utf-8'));
  }

  /** Set one or more env vars (merge with existing) */
  set(vars: Record<string, string>): void {
    const current = this.readAll();
    const merged = { ...current, ...vars };
    writeFileSync(this.envPath, stringify(merged), { mode: 0o600 });

    // Also update process.env so current process sees changes
    for (const [k, v] of Object.entries(vars)) {
      process.env[k] = v;
    }
  }

  /** Remove env vars */
  remove(keys: string[]): void {
    const current = this.readAll();
    for (const k of keys) {
      delete current[k];
      delete process.env[k];
    }
    writeFileSync(this.envPath, stringify(current), { mode: 0o600 });
  }

  /** Check which vars are set (names only, no values) */
  status(keys: string[]): Record<string, boolean> {
    const current = this.readAll();
    const result: Record<string, boolean> = {};
    for (const k of keys) {
      result[k] = k in current && current[k].length > 0;
    }
    return result;
  }
}
```

### Per-Caller Secret Naming Convention

To avoid collisions when multiple callers use the same connection:

```
Pattern: {CALLER_ALIAS}_{SECRET_NAME}

Example:
  Caller "agent-1" with Discord:  AGENT1_DISCORD_BOT_TOKEN=abc123
  Caller "agent-2" with Discord:  AGENT2_DISCORD_BOT_TOKEN=xyz789

  In remote.config.json callers:
    "agent-1": { env: { "DISCORD_BOT_TOKEN": "${AGENT1_DISCORD_BOT_TOKEN}" } }
    "agent-2": { env: { "DISCORD_BOT_TOKEN": "${AGENT2_DISCORD_BOT_TOKEN}" } }
```

The `admin_set_secrets` handler automatically generates these prefixed names.

---

## Part 4: Bootstrap — First-Run Initialization

### Problem

claude-code-ui needs to programmatically initialize a fresh mcp-secure-proxy config directory from its setup wizard. The bootstrap should work for both local and remote mode.

### Solution: Exported `bootstrap()` function

New file: `src/cli/bootstrap.ts`

Usable as CLI or imported directly by claude-code-ui:

```bash
# CLI usage:
npx mcp-secure-proxy bootstrap [--config-dir /path/to/.mcp-secure-proxy]
```

```typescript
// Programmatic usage from claude-code-ui:
import { bootstrap } from 'mcp-secure-proxy/bootstrap';
const result = await bootstrap('~/.mcp-secure-proxy');
```

This function:
1. Creates `.mcp-secure-proxy/` directory structure
2. Generates a default local keypair (`keys/local/default/`)
3. For remote mode: also generates remote server keypair + cross-registers
4. Creates default `remote.config.json` with the default caller
5. Creates empty `.env`
6. Returns summary

```typescript
// src/cli/bootstrap.ts
export interface BootstrapOptions {
  /** Whether to generate remote server keys (needed for running a remote server) */
  includeRemoteKeys?: boolean;
}

export interface BootstrapResult {
  configDir: string;
  defaultAlias: string;
  clientFingerprint: string;
  serverFingerprint?: string;  // only if includeRemoteKeys
}

export async function bootstrap(configDir: string, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const { includeRemoteKeys = false } = options;

  // 1. Create directory structure
  mkdirSync(join(configDir, 'keys/local/default'), { recursive: true, mode: 0o700 });
  mkdirSync(join(configDir, 'keys/peers/default'), { recursive: true, mode: 0o700 });

  // 2. Generate default client keypair
  const clientKeys = generateKeyBundle();
  saveKeyBundle(clientKeys, join(configDir, 'keys/local/default'));
  copyPublicKeys(join(configDir, 'keys/local/default'), join(configDir, 'keys/peers/default'));

  // 3. Optionally generate server keypair (for remote mode / running as server)
  let serverFingerprint: string | undefined;
  if (includeRemoteKeys) {
    mkdirSync(join(configDir, 'keys/remote'), { recursive: true, mode: 0o700 });
    mkdirSync(join(configDir, 'keys/peers/remote-server'), { recursive: true, mode: 0o700 });
    const serverKeys = generateKeyBundle();
    saveKeyBundle(serverKeys, join(configDir, 'keys/remote'));
    copyPublicKeys(join(configDir, 'keys/remote'), join(configDir, 'keys/peers/remote-server'));
    serverFingerprint = fingerprint(extractPublicKeys(serverKeys));
  }

  // 4. Create default remote.config.json
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 9999,
    localKeysDir: join(configDir, 'keys/remote'),
    callers: {
      'default': {
        name: 'Default',
        peerKeyDir: join(configDir, 'keys/peers/default'),
        connections: [],
        role: 'admin',
        env: {}
      }
    },
    rateLimitPerMinute: 60
  };
  writeFileSync(join(configDir, 'remote.config.json'), JSON.stringify(config, null, 2));

  // 5. Create empty .env
  writeFileSync(join(configDir, '.env'), '# MCP Secure Proxy Secrets\n', { mode: 0o600 });

  return {
    configDir,
    defaultAlias: 'default',
    clientFingerprint: fingerprint(extractPublicKeys(clientKeys)),
    serverFingerprint,
  };
}
```

---

## Part 5: Remote Config Management Helpers

### Problem

The admin tools need to atomically read-modify-write `remote.config.json`. Currently config is loaded once at startup.

### Solution: Config Manager

New file: `src/remote/config-manager.ts`

```typescript
export class ConfigManager {
  private configPath: string;

  constructor(configDir: string) {
    this.configPath = join(configDir, 'remote.config.json');
  }

  /** Load current config from disk */
  load(): RemoteServerConfig { /* parse + validate with zod */ }

  /** Save config to disk (atomic write via rename) */
  save(config: RemoteServerConfig): void {
    const tmpPath = this.configPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, this.configPath);
  }

  /** Add a caller */
  addCaller(alias: string, caller: CallerConfig): RemoteServerConfig {
    const config = this.load();
    if (config.callers[alias]) throw new Error(`Caller "${alias}" already exists`);
    config.callers[alias] = caller;
    this.save(config);
    return config;
  }

  /** Remove a caller */
  removeCaller(alias: string): RemoteServerConfig {
    const config = this.load();
    if (!config.callers[alias]) throw new Error(`Caller "${alias}" not found`);
    delete config.callers[alias];
    this.save(config);
    return config;
  }

  /** Update a caller's connections list */
  updateCallerConnections(alias: string, connections: string[]): RemoteServerConfig {
    const config = this.load();
    if (!config.callers[alias]) throw new Error(`Caller "${alias}" not found`);
    config.callers[alias].connections = connections;
    this.save(config);
    return config;
  }

  /** Update a caller's env mapping */
  updateCallerEnv(alias: string, env: Record<string, string>): RemoteServerConfig {
    const config = this.load();
    if (!config.callers[alias]) throw new Error(`Caller "${alias}" not found`);
    config.callers[alias].env = { ...config.callers[alias].env, ...env };
    this.save(config);
    return config;
  }

  /** Add a custom connector */
  addConnector(connector: Route): RemoteServerConfig {
    const config = this.load();
    config.connectors = config.connectors ?? [];
    config.connectors.push(connector);
    this.save(config);
    return config;
  }
}
```

---

## Part 6: Connection Template Introspection

### Problem

claude-code-ui needs to know what secrets each connection template requires so it can show the right form fields in the UI. In local mode, it imports this directly. In remote mode, it calls `admin_list_connection_templates`.

### Solution: Template Metadata API

Enhance `src/shared/connections.ts` to expose template metadata:

```typescript
export interface ConnectionTemplateInfo {
  alias: string;
  name: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  requiredSecrets: string[];      // Secret names needed (e.g., ["DISCORD_BOT_TOKEN"])
  optionalSecrets: string[];      // Optional secrets (e.g., ["GITHUB_WEBHOOK_SECRET"])
  hasIngestor: boolean;
  ingestorType?: 'websocket' | 'webhook' | 'poll';
  ingestorConfig?: {
    /** Configurable overrides the user might want to adjust */
    supportsEventFilter: boolean;
    supportsGuildFilter: boolean;    // Discord-specific
    supportsChannelFilter: boolean;  // Discord-specific
    supportsBufferSize: boolean;
    supportsIntervalMs: boolean;     // Poll-specific
  };
  allowedEndpoints: string[];
}

/** List all available connection templates with metadata */
export function listConnectionTemplates(): ConnectionTemplateInfo[] {
  // 1. Scan src/connections/*.json
  // 2. Parse each template
  // 3. Categorize secrets as required vs optional
  //    (all secrets in headers are required; others are optional)
  // 4. Return structured metadata
}
```

This function is called by:
- `admin_list_connection_templates` tool handler (remote mode)
- Directly by claude-code-ui in local mode (via package import)

---

## Part 7: File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/remote/admin-handlers.ts` | Admin tool handler implementations |
| `src/remote/config-manager.ts` | Atomic config read/modify/write |
| `src/remote/env-manager.ts` | .env file read/write/status |
| `src/cli/bootstrap.ts` | First-run initialization (CLI + programmatic) |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Add `exports` map, add `bootstrap` script |
| `src/shared/config.ts` | Add `role` to `CallerConfig`; verify all config helpers are exported |
| `src/shared/connections.ts` | Add `listConnectionTemplates()` function and `ConnectionTemplateInfo` type |
| `src/shared/crypto/index.ts` | Verify/add all exports needed by claude-code-ui |
| `src/shared/protocol/index.ts` | Verify/add all exports needed by claude-code-ui |
| `src/remote/server.ts` | Register admin tool handlers; verify `matchRoute`, `isEndpointAllowed` are exported |
| `src/remote/ingestors/index.ts` | Verify `IngestorManager` is exported |
| `src/mcp/server.ts` | Register admin tools in MCP tool list |
| `tsconfig.json` | Ensure `declaration: true` for type exports |

---

## Part 8: Implementation Phases

### Phase 1: Package Exports (enables file-ref / npm consumption)
1. Add `exports` map to `package.json`
2. Verify/add all necessary re-exports from index files (crypto, protocol, config, ingestors, server core functions)
3. Enable `declaration: true` in tsconfig
4. Test import from claude-code-ui via `file:` dependency — verify `LocalProxy` can import and call `matchRoute`, `resolveCallerRoutes`, `IngestorManager`, etc.

### Phase 2: Bootstrap
1. Create `src/cli/bootstrap.ts` with both CLI and programmatic `bootstrap()` export
2. Add `bootstrap` script to `package.json`
3. Test: fresh directory → fully initialized config

### Phase 3: Config Manager + Env Manager
1. Create `ConfigManager` class
2. Create `EnvManager` class
3. Unit tests for both (atomic writes, concurrent safety)

### Phase 4: Admin API
1. Add `role` field to `CallerConfig`
2. Create admin handler module with all 7 tool handlers
3. Register in server's `toolHandlers` map
4. Register in MCP proxy's tool list
5. Integration tests: admin caller → register new caller → new caller authenticates

### Phase 5: Connection Introspection
1. Add `listConnectionTemplates()` to `src/shared/connections.ts`
2. Add `ConnectionTemplateInfo` type
3. Wire into `admin_list_connection_templates` handler

---

## Security Considerations

1. **Admin Role Isolation**: Admin tools MUST be gated by `assertAdmin()`. A non-admin caller invoking an admin tool should get a clear error, not a crash.
2. **Self-Protection**: Admin cannot remove their own caller entry (prevents lockout).
3. **Secret Handling**: `admin_set_secrets` receives plaintext secrets through the encrypted channel. The remote server writes them to `.env` with 0600 permissions. Secrets are never returned in any response — only presence/absence status.
4. **Atomic Config Writes**: Use write-to-temp + rename pattern to prevent partial writes from corrupting config.
5. **Rate Limiting**: Admin tools count toward the caller's rate limit (no special exemption).
6. **Audit Logging**: All admin operations are audit-logged with caller alias, action, and affected resource.
7. **In-process local mode**: When claude-code-ui runs the core logic in-process, there is no network boundary — secrets are in the same process memory. This is acceptable because it's a single-user local setup. The `.env` file still uses 0600 permissions for at-rest protection.
