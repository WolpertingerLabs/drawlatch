# Plan: mcp-secure-proxy — Staged Integration with claude-code-ui

## Stage Dependency Graph

```
mcp-secure-proxy Stage 1  ──→  claude-code-ui Stage 1
  (exports + executeProxyRequest)    (LocalProxy + proxy tools injection)

mcp-secure-proxy Stage 2  ──→  claude-code-ui Stage 2
  (connection template introspection) (connection management UI, local mode)

mcp-secure-proxy Stage 3  ──→  claude-code-ui Stage 3
  (admin API + bootstrap)            (remote provisioning + key management)
```

Each stage ships independently. Later stages do NOT block earlier ones.

---

## Stage 1: Package Exports + `executeProxyRequest()` ✅ COMPLETE

### Problem

claude-code-ui cannot import from mcp-secure-proxy as a package — there's no `exports` map in `package.json`, so Node refuses subpath imports like `mcp-secure-proxy/shared/crypto`. claude-code-ui currently vendors a 410-line copy of the crypto/handshake code in `proxy-client.ts`.

Additionally, the core HTTP request logic (route matching → placeholder resolution → header merging → fetch) lives inline in the `http_request` tool handler in `server.ts`. claude-code-ui's `LocalProxy` needs to call this same logic in-process. Without extracting it, the logic would be duplicated and drift over time.

### Solution

#### 1a. Add `exports` map to `package.json`

```json
{
  "exports": {
    ".": "./dist/mcp/server.js",
    "./shared/crypto": "./dist/shared/crypto/index.js",
    "./shared/protocol": "./dist/shared/protocol/index.js",
    "./shared/config": "./dist/shared/config.js",
    "./shared/connections": "./dist/shared/connections.js",
    "./remote/server": "./dist/remote/server.js",
    "./remote/ingestors": "./dist/remote/ingestors/index.js"
  }
}
```

#### 1b. Extract `executeProxyRequest()` from `http_request` handler

Currently, the inline `http_request` handler in `server.ts` (lines 223–323) contains ~100 lines of request execution logic: route matching, URL resolution, header conflict detection, header merging, body resolution, endpoint validation, fetch, and response parsing.

Extract this into a named, exported pure function:

```typescript
// src/remote/server.ts (new exported function)

export interface ProxyRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ProxyRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Core proxy request execution — route matching, secret injection, and fetch.
 *
 * Used by:
 * - The remote server's `http_request` tool handler (this file)
 * - claude-code-ui's `LocalProxy` class (in-process, no encryption)
 *
 * Pure in the sense that it takes routes as input rather than reading global state.
 * The only side effect is the outbound fetch().
 */
export async function executeProxyRequest(
  input: ProxyRequestInput,
  routes: ResolvedRoute[],
): Promise<ProxyRequestResult> {
  const { method, url, headers = {}, body } = input;

  // Step 1: Find matching route — try raw URL first
  let matched: ResolvedRoute | null = matchRoute(url, routes);
  let resolvedUrl = url;

  if (matched) {
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

  // Step 2: Resolve client headers
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    resolvedHeaders[k] = resolvePlaceholders(v, matched.secrets);
  }

  // Step 3: Reject conflicting headers
  const routeHeaderKeys = new Set(
    Object.keys(matched.headers).map((k) => k.toLowerCase()),
  );
  for (const clientKey of Object.keys(resolvedHeaders)) {
    if (routeHeaderKeys.has(clientKey.toLowerCase())) {
      throw new Error(
        `Header conflict: client-provided header "${clientKey}" conflicts with a route-level header. Remove it from the request.`,
      );
    }
  }

  // Step 4: Merge route-level headers
  for (const [k, v] of Object.entries(matched.headers)) {
    resolvedHeaders[k] = v;
  }

  // Step 5: Resolve body placeholders
  let resolvedBody: string | undefined;
  if (typeof body === "string") {
    resolvedBody = matched.resolveSecretsInBody
      ? resolvePlaceholders(body, matched.secrets)
      : body;
  } else if (body !== null && body !== undefined) {
    const serialized = JSON.stringify(body);
    resolvedBody = matched.resolveSecretsInBody
      ? resolvePlaceholders(serialized, matched.secrets)
      : serialized;
    if (
      !resolvedHeaders["content-type"] &&
      !resolvedHeaders["Content-Type"]
    ) {
      resolvedHeaders["Content-Type"] = "application/json";
    }
  }

  // Step 6: Final endpoint check on resolved URL
  if (!isEndpointAllowed(resolvedUrl, matched.allowedEndpoints)) {
    throw new Error(`Endpoint not allowed after resolution: ${url}`);
  }

  // Step 7: Fetch
  const resp = await fetch(resolvedUrl, {
    method,
    headers: resolvedHeaders,
    body: resolvedBody,
  });

  const contentType = resp.headers.get("content-type") ?? "";
  let responseBody: unknown;
  if (contentType.includes("application/json")) {
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
```

Then update the inline `http_request` handler to delegate:

```typescript
async http_request(input, routes, _context) {
  return executeProxyRequest(input as ProxyRequestInput, routes);
},
```

#### 1c. Verify existing exports are sufficient

All exports needed by claude-code-ui already exist in the source files. Verify after adding the `exports` map that these imports resolve:

| Import path | Symbols needed |
|---|---|
| `mcp-secure-proxy/shared/crypto` | `generateKeyBundle`, `saveKeyBundle`, `loadKeyBundle`, `loadPublicKeys`, `extractPublicKeys`, `fingerprint`, `EncryptedChannel`, `deriveSessionKeys` + types |
| `mcp-secure-proxy/shared/protocol` | `HandshakeInitiator`, `HandshakeResponder` + types |
| `mcp-secure-proxy/shared/config` | `loadRemoteConfig`, `saveRemoteConfig`, `resolveCallerRoutes`, `resolveRoutes`, `resolveSecrets`, `resolvePlaceholders`, `CONFIG_DIR`, `KEYS_DIR`, `LOCAL_KEYS_DIR`, `REMOTE_KEYS_DIR`, `PEER_KEYS_DIR` + types |
| `mcp-secure-proxy/shared/connections` | `loadConnection`, `listAvailableConnections` |
| `mcp-secure-proxy/remote/server` | `executeProxyRequest`, `matchRoute`, `isEndpointAllowed` + types |
| `mcp-secure-proxy/remote/ingestors` | `IngestorManager` + types |

### Files to Change

| File | Change |
|---|---|
| `package.json` | Add `exports` map |
| `src/remote/server.ts` | Extract `executeProxyRequest()` function, export it, update `http_request` handler to delegate |

### Done When

- `npm run build` succeeds
- A test file (or claude-code-ui) can `import { executeProxyRequest } from "mcp-secure-proxy/remote/server"` and call it
- A test file can `import { HandshakeInitiator, EncryptedChannel } from "mcp-secure-proxy/shared/crypto"` (replacing vendored code)
- The existing remote server's `http_request` handler behavior is unchanged (it just delegates now)

### Implementation Notes (2026-02-22)

**All criteria met.** Implemented in two files:

1. **`package.json`** — Added 7-entry `exports` map. All dist paths verified to exist post-build.
2. **`src/remote/server.ts`** — Extracted `executeProxyRequest()` as a new exported function (~100 lines) with `ProxyRequestInput` and `ProxyRequestResult` interfaces. The `http_request` tool handler now delegates with a single line. Required `as unknown as ProxyRequestInput` double-cast because the `ToolHandler` type signature uses `Record<string, unknown>`.

**Verification:**
- `npm run build` — clean, no errors
- `npm test` — 438/438 tests pass (15 test files), zero regressions
- `dist/remote/server.d.ts` exports `executeProxyRequest`, `ProxyRequestInput`, `ProxyRequestResult`
- All 7 export subpaths resolve to existing `.js` files in `dist/`

---

## Stage 2: Connection Template Introspection

### Problem

claude-code-ui needs to know what secrets each connection template requires to show form fields in the connections management UI. The current `listAvailableConnections()` only returns alias strings — no metadata about required secrets, ingestor types, or descriptions.

### Solution

Add `listConnectionTemplates()` to `src/shared/connections.ts`:

```typescript
export interface ConnectionTemplateInfo {
  alias: string;
  name: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  requiredSecrets: string[];     // Secrets referenced in headers (always required)
  optionalSecrets: string[];     // Secrets referenced elsewhere (body templates, etc.)
  hasIngestor: boolean;
  ingestorType?: "websocket" | "webhook" | "poll";
  allowedEndpoints: string[];
}

/**
 * List all available connection templates with metadata.
 *
 * Scans built-in connection JSON files, parses each template,
 * and categorizes secrets as required vs. optional.
 *
 * Used by:
 * - claude-code-ui's ConnectionManager (local mode, direct import)
 * - admin_list_connection_templates tool handler (remote mode, Stage 3)
 */
export function listConnectionTemplates(): ConnectionTemplateInfo[] {
  // 1. Get all available connection aliases
  // 2. For each: loadConnection(alias) → Route
  // 3. Extract secret names from headers (required) and other fields (optional)
  // 4. Detect ingestor presence and type from route.ingestor field
  // 5. Return structured metadata
}
```

### Files to Change

| File | Change |
|---|---|
| `src/shared/connections.ts` | Add `ConnectionTemplateInfo` interface + `listConnectionTemplates()` function |

### Done When

- `listConnectionTemplates()` returns metadata for all 23+ built-in connection templates
- Each template shows correct `requiredSecrets` (parsed from header `${VAR}` placeholders)
- `hasIngestor` and `ingestorType` accurately reflect the template's ingestor config
- claude-code-ui can call `import { listConnectionTemplates } from "mcp-secure-proxy/shared/connections"` and render connection cards from the result

---

## Stage 3: Admin API + Bootstrap + Config/Env Management

### Problem

In remote mode, claude-code-ui can't manage callers, connections, or secrets on the server — it can only make requests through existing registered callers. A management API is needed so the UI can provision new callers, set secrets, and query status through the existing encrypted channel (no new HTTP endpoints).

Additionally, new users need a way to initialize a fresh config directory programmatically (from claude-code-ui's setup wizard).

### Solution

#### 3a. Caller Roles

Extend `CallerConfig` with an optional `role` field:

```typescript
// In src/shared/config.ts
export interface CallerConfig {
  name?: string;
  peerKeyDir: string;
  connections: string[];
  env?: Record<string, string>;
  ingestorOverrides?: Record<string, IngestorOverrides>;

  /** "admin" grants access to management tools. Default: "user". */
  role?: "admin" | "user";
}
```

#### 3b. Three Essential Admin Tool Handlers

New file: `src/remote/admin-handlers.ts`

Start with three tools. Add more only when a real use case demands them.

**`admin_list_callers`** — List all registered callers and their connections.
```typescript
// Returns: [{ alias, name, connections, role, fingerprint }]
// No secret values are ever returned.
```

**`admin_set_secrets`** — Set or update secrets for a caller's connection.
```typescript
// Input: { callerAlias, connectionAlias, secrets: { KEY: "value" } }
// Writes to .env with per-caller prefix (CALLER_ALIAS_SECRET_NAME=value)
// Updates caller.env mapping in remote.config.json
// Returns: { success, secretsSet, restartRequired }
```

**`admin_register_caller`** — Register a new caller by providing their public keys.
```typescript
// Input: { callerAlias, name?, signingPubPem, exchangePubPem, connections }
// Writes public keys to keys/peers/{callerAlias}/
// Adds caller entry to remote.config.json
// Returns: { success, callerAlias, fingerprint, restartRequired }
```

Each handler is gated by `assertAdmin(context)`:

```typescript
function assertAdmin(context: ToolContext): void {
  const config = loadRemoteConfig();
  const caller = config.callers[context.callerAlias];
  if (!caller || caller.role !== "admin") {
    throw new Error(`Caller "${context.callerAlias}" is not authorized for admin operations`);
  }
}
```

#### 3c. ConfigManager — Atomic Config Read/Modify/Write

New file: `src/remote/config-manager.ts`

```typescript
export class ConfigManager {
  constructor(configDir: string);
  load(): RemoteServerConfig;
  save(config: RemoteServerConfig): void;  // atomic: write-to-tmp + rename
  addCaller(alias: string, caller: CallerConfig): RemoteServerConfig;
  removeCaller(alias: string): RemoteServerConfig;
  updateCallerConnections(alias: string, connections: string[]): RemoteServerConfig;
  updateCallerEnv(alias: string, env: Record<string, string>): RemoteServerConfig;
}
```

#### 3d. EnvManager — .env File Read/Write/Status

New file: `src/remote/env-manager.ts`

```typescript
export class EnvManager {
  constructor(configDir: string);
  readAll(): Record<string, string>;
  set(vars: Record<string, string>): void;       // merge + write 0600 + update process.env
  remove(keys: string[]): void;
  status(keys: string[]): Record<string, boolean>; // presence check, never returns values
}
```

Per-caller secret naming convention: `{CALLER_ALIAS}_{SECRET_NAME}` (e.g., `AGENT1_DISCORD_BOT_TOKEN`).

#### 3e. Bootstrap — First-Run Initialization

New file: `src/cli/bootstrap.ts`

Exported for programmatic use by claude-code-ui's setup wizard:

```typescript
export interface BootstrapOptions {
  includeRemoteKeys?: boolean;
}

export interface BootstrapResult {
  configDir: string;
  defaultAlias: string;
  clientFingerprint: string;
  serverFingerprint?: string;
}

export async function bootstrap(
  configDir: string,
  options?: BootstrapOptions,
): Promise<BootstrapResult>;
```

Creates: directory structure, default keypair, `remote.config.json` (with default admin caller), empty `.env`.

Add to package.json exports:
```json
{
  "./bootstrap": "./dist/cli/bootstrap.js",
  "./remote/config-manager": "./dist/remote/config-manager.js",
  "./remote/env-manager": "./dist/remote/env-manager.js"
}
```

### Files to Change

| File | Change |
|---|---|
| `src/shared/config.ts` | Add `role` to `CallerConfig` interface |
| `src/remote/admin-handlers.ts` | **New.** Three admin tool handlers + `assertAdmin()` |
| `src/remote/config-manager.ts` | **New.** Atomic config read/modify/write |
| `src/remote/env-manager.ts` | **New.** .env file management |
| `src/cli/bootstrap.ts` | **New.** First-run initialization |
| `src/remote/server.ts` | Register admin tool handlers in `toolHandlers` map |
| `src/mcp/server.ts` | Register admin tools in MCP tool list |
| `package.json` | Add new export paths |

### Security Considerations

1. **Admin role isolation** — `assertAdmin()` on every admin handler. Non-admin callers get clear error, not a crash.
2. **Self-protection** — `admin_register_caller` prevents duplicate aliases; future `admin_remove_caller` prevents self-removal.
3. **Secret handling** — Plaintext secrets travel through the encrypted channel. Written to `.env` with 0600 permissions. Never returned in any response — only presence/absence via `admin_get_secret_status` (future tool).
4. **Atomic config writes** — Write-to-temp + rename to prevent corruption.
5. **Rate limiting** — Admin tools count toward the caller's rate limit.

### Done When

- An admin caller can call `admin_list_callers` and see all registered callers
- An admin caller can call `admin_register_caller` with public key PEMs and a new caller entry appears in config
- An admin caller can call `admin_set_secrets` and the secrets are written to `.env` with correct per-caller prefixing
- A non-admin caller calling any admin tool gets a clear authorization error
- `bootstrap("/tmp/test-config")` creates a fully initialized config directory
- claude-code-ui can import `bootstrap` from `mcp-secure-proxy/bootstrap`
