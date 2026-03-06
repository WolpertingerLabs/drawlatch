# Drawlatch: Remote Config Management Tools

## Goal

Add new tool handlers to the remote server so that external hosts like callboard can manage connections, secrets, and callers over the encrypted channel — the same operations that callboard's `connection-manager.ts` performs locally via direct file access.

## Context

Currently, drawlatch's remote server exposes tools for **reading** config (list_routes, get_listener_params, list_listener_instances) and **writing** listener params (set_listener_params), but has no tools for managing connections, secrets, or callers. Callboard in local mode does all this via direct file I/O against `remote.config.json` and `.env`. In remote mode, callboard is limited to read-only views.

## Scope Control: Permitted Keys

Callers should only be able to manage their **own** configuration — the config for the caller alias they authenticated as. They must NOT be able to:
- Modify other callers' config
- Change server-level settings (host, port, localKeysDir, rateLimitPerMinute)
- Add/remove custom connectors
- Access raw secret values (only set/check status)

The caller identity is already established during the encrypted handshake and available as `context.callerAlias`.

## New Tool Handlers

### 1. `list_connection_templates`

List ALL available connection templates (built-in + custom connectors), not just the caller's enabled ones. Returns template metadata plus which ones the caller has enabled, and which secrets are set.

**Input:** (none)

**Returns:** Array of objects:
```ts
{
  alias: string;
  name: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  stability?: "stable" | "beta" | "dev";
  category?: string;
  requiredSecrets: string[];      // secret names required for headers
  optionalSecrets: string[];      // secret names used elsewhere
  hasIngestor: boolean;
  ingestorType?: string;
  allowedEndpoints: string[];
  enabled: boolean;               // whether this caller has it enabled
  requiredSecretsSet: Record<string, boolean>;  // which required secrets are configured
  optionalSecretsSet: Record<string, boolean>;  // which optional secrets are configured
}
```

**Implementation notes:**
- Use `listConnectionTemplates()` from `shared/connections` to get all templates
- Check `config.callers[callerAlias].connections` for enabled status
- Use `resolveSecrets()` or check `.env` / `process.env` for secret status (return boolean only, never values)
- Reuse the caller's `env` mapping for prefixed env var resolution

### 2. `set_connection_enabled`

Enable or disable a connection for the authenticated caller.

**Input:**
```ts
{ connection: string; enabled: boolean }
```

**Returns:**
```ts
{ success: boolean; connection: string; enabled: boolean }
```

**Implementation notes:**
- Modify `config.callers[callerAlias].connections` array
- `saveRemoteConfig(config)`
- Reinitialize affected ingestors (start new ones / stop removed ones)

### 3. `set_secrets`

Set or delete secrets for the authenticated caller. Uses prefixed env vars (same pattern as callboard's local connection-manager).

**Input:**
```ts
{ secrets: Record<string, string> }  // empty string = delete
```

**Returns:**
```ts
{ success: boolean; secretsSet: Record<string, boolean> }  // never returns values
```

**Implementation notes:**
- Compute prefixed env var names: `${CALLER_PREFIX}_${SECRET_NAME}`
- Write to `.env` file (same format as callboard's `setEnvVars()`)
- Update `config.callers[callerAlias].env` mapping (e.g., `"GITHUB_TOKEN": "${DEFAULT_GITHUB_TOKEN}"`)
- `saveRemoteConfig(config)`
- Set `process.env` for immediate in-process effect
- Re-resolve routes for this caller so new secrets take effect
- Return boolean status per secret name

### 4. `get_secret_status`

Check which secrets are set for the authenticated caller (never returns values).

**Input:**
```ts
{ connection: string }  // connection alias
```

**Returns:**
```ts
{
  success: boolean;
  connection: string;
  requiredSecretsSet: Record<string, boolean>;
  optionalSecretsSet: Record<string, boolean>;
}
```

**Implementation notes:**
- Load the connection template to get required/optional secret names
- Check caller's env mapping + process.env for each secret
- Same resolution logic as callboard's `isSecretSetForCaller()`

### 5. `list_callers` (optional, lower priority)

List all caller aliases visible to the authenticated caller. For security, this could be limited to just returning the caller's own alias info, or all callers if the server opts in.

**Input:** (none)

**Returns:**
```ts
{ callers: Array<{ alias: string; name?: string; connectionCount: number }> }
```

**Note:** Caller creation/deletion is a higher-privilege operation that should remain server-side only. This tool is read-only.

## Files to Modify

### New: `src/shared/env-utils.ts` (exported as `./shared/env-utils`)

Extract the `.env` file and secret-status utilities that currently live **duplicated** in callboard's `connection-manager.ts`. Drawlatch should own these since both the remote server and callboard's local mode need them. Callboard will then import from drawlatch instead of maintaining its own copies.

**Functions to include (moved from callboard's `connection-manager.ts`):**

```ts
/** Convert caller alias to env var prefix: "default" → "DEFAULT", "my-agent" → "MY_AGENT" */
export function callerToPrefix(callerAlias: string): string;

/** Get prefixed env var name: ("default", "GITHUB_TOKEN") → "DEFAULT_GITHUB_TOKEN" */
export function prefixedEnvVar(callerAlias: string, secretName: string): string;

/** Load all vars from the .env file into a map (does NOT set process.env). */
export function loadEnvFile(): Record<string, string>;

/** Load .env file into process.env (for startup). */
export function loadEnvIntoProcess(): void;

/**
 * Write key-value pairs to .env. Empty string = delete.
 * Also sets process.env immediately for in-process use.
 */
export function setEnvVars(updates: Record<string, string>): void;

/**
 * Check if a secret is set for a caller.
 * Resolution: caller env mapping → prefixed env var → bare env var.
 */
export function isSecretSetForCaller(
  secretName: string,
  callerAlias: string,
  callerEnv?: Record<string, string>,
): boolean;

/**
 * Set secrets for a caller with prefixed env vars.
 * Updates .env file, process.env, and caller's env mapping in config.
 * Returns boolean status per secret name.
 */
export function setCallerSecrets(
  secrets: Record<string, string>,
  callerAlias: string,
  config: RemoteServerConfig,
): { config: RemoteServerConfig; status: Record<string, boolean> };
```

All functions use `getEnvFilePath()` from `shared/config.ts` for path resolution.

### `package.json` — add export

```json
"./shared/env-utils": {
  "types": "./dist/shared/env-utils.d.ts",
  "import": "./dist/shared/env-utils.js"
}
```

### `src/remote/server.ts`
- Add new tool handlers to the `toolHandlers` record
- Import from `shared/env-utils` and `shared/connections`

### `src/shared/connections.ts`
- Already exports `listConnectionTemplates()` — verify it returns `requiredSecrets` / `optionalSecrets` arrays

### `src/mcp/server.ts` (MCP tool definitions)
- Add MCP tool schemas for the new tools so Claude Code can also use them directly

## Security Considerations

1. **Caller isolation**: All operations scoped to `context.callerAlias` — a caller cannot modify another caller's config
2. **Secret values never returned**: Only boolean "is set" status
3. **No server config mutation**: Callers cannot change host/port/keys/rate limits
4. **Env var prefix scoping**: Secrets are written with caller-specific prefixes to prevent cross-caller collisions
5. **Config file permissions**: `.env` written with `mode: 0o600` (same as callboard)

## Connection Template Secret Classification

Drawlatch connection templates currently expose secrets as a flat `secrets` map on the `Route` interface. For the `list_connection_templates` tool, we need to classify which secrets are "required" (referenced in route headers, needed for any request) vs "optional" (used by ingestors, URL placeholders, etc.).

**Approach**: The `listConnectionTemplates()` function already returns `requiredSecrets` and `optionalSecrets` arrays. Verify this is accurate for all 22 built-in connections.

## Migration Path

These tools are additive — no breaking changes. Callboard's remote mode will:
1. Detect whether the remote server supports `list_connection_templates` (graceful fallback on "Unknown tool")
2. If supported, use it instead of `list_routes` for the connections settings page
3. Enable the Configure button, toggle switches, and caller management in remote mode

The existing `safeCallTool()` pattern in callboard's proxy routes already handles "Unknown tool" gracefully, so older drawlatch versions will continue to work in read-only mode.
