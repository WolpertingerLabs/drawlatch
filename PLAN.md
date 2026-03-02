# Drawlatch: Test Connection, Test Listener, Listener Configuration & Lifecycle

## Overview

This plan adds four major capabilities to Drawlatch:

1. **Test Connection** — verify API credentials work with a zero-side-effect request
2. **Test Event Listener** — verify ingestor configuration is correct (credentials, webhook registration, etc.)
3. **Configurable Event Listeners** — a schema-driven configuration system for ingestors (which boards to watch, which events to filter, etc.)
4. **Listener Enable/Disable** — start/stop individual ingestors at runtime without restarting the server

Plus a **gap analysis** section at the end for anything missed.

---

## 1. Test Connection

### Concept

Each connection template (e.g., `github.json`, `discord-bot.json`) defines a `testConnection` block — a pre-configured, non-destructive, read-only HTTP request that verifies the credentials work. The remote server executes this request using the caller's resolved secrets and returns pass/fail.

### Schema Addition to Connection Templates

Add a new optional `testConnection` field to the `Route` interface:

```typescript
/** Pre-configured test request for verifying connection credentials. */
interface TestConnectionConfig {
  /** HTTP method (default: 'GET'). Should always be non-destructive. */
  method?: string;
  /** URL to test against. May contain ${VAR} placeholders. */
  url: string;
  /** Optional headers (merged under route headers). May contain ${VAR} placeholders. */
  headers?: Record<string, string>;
  /** Optional request body. May contain ${VAR} placeholders. */
  body?: unknown;
  /** Human-readable description of what this test does (e.g., "Fetches authenticated user"). */
  description?: string;
  /** Expected HTTP status code(s) that indicate success (default: [200]). */
  expectedStatus?: number[];
}
```

### Per-Connection Test Configurations

| Connection | Test Request | Notes |
|---|---|---|
| **github** | `GET https://api.github.com/user` | Returns authenticated user |
| **discord-bot** | `GET https://discord.com/api/v10/users/@me` | Returns bot user |
| **slack** | `POST https://slack.com/api/auth.test` | Slack auth check endpoint |
| **stripe** | `GET https://api.stripe.com/v1/balance` | Read-only balance check |
| **trello** | `GET https://api.trello.com/1/members/me?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` | Returns authenticated member |
| **notion** | `GET https://api.notion.com/v1/users/me` | Returns bot user |
| **openai** | `GET https://api.openai.com/v1/models` | Lists available models |
| **linear** | `POST https://api.linear.app/graphql` with body `{"query":"{ viewer { id name } }"}` | GraphQL viewer query |
| **jira** | `GET https://${JIRA_DOMAIN}/rest/api/3/myself` | Returns authenticated user |
| **confluence** | `GET https://${CONFLUENCE_DOMAIN}/wiki/rest/api/user/current` | Returns current user |
| **anthropic** | `GET https://api.anthropic.com/v1/models` | Lists available models |
| **reddit** | `GET https://oauth.reddit.com/api/v1/me` | Returns authenticated user |
| **x** | `GET https://api.x.com/2/users/me` | Returns authenticated user |
| **telegram-bot** | `GET https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe` | Returns bot info |
| **twitch** | `GET https://api.twitch.tv/helix/users` | Returns authenticated user |
| **mastodon** | `GET https://${MASTODON_INSTANCE}/api/v1/accounts/verify_credentials` | Returns account |
| **bluesky** | `GET https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${BLUESKY_HANDLE}` | Returns profile |
| **google** | `GET https://www.googleapis.com/oauth2/v1/userinfo` | Returns user info |
| **discord-oauth** | `GET https://discord.com/api/v10/users/@me` | Returns OAuth user |
| **shopify** | `GET https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-01/shop.json` | Returns shop info |
| **sendgrid** | `GET https://api.sendgrid.com/v3/user/profile` | Returns user profile |
| **hubspot** | `GET https://api.hubapi.com/account-info/v3/api-usage/daily/private` | Returns account info |

### Prerequisite: Carry `alias` and New Config Through `ResolvedRoute`

Currently `ResolvedRoute` loses the alias and has no path to the raw `Route` fields we're adding. We need to extend it:

```typescript
interface ResolvedRoute {
  // ... existing fields (name, description, docsUrl, openApiUrl, headers, secrets, allowedEndpoints, resolveSecretsInBody) ...
  alias?: string;
  testConnection?: TestConnectionConfig;
  testIngestor?: TestIngestorConfig | null;
  listenerConfig?: ListenerConfigSchema;
  ingestorConfig?: IngestorConfig;  // carried from Route.ingestor
}
```

Update `resolveRoutes()` and `resolveCallerRoutes()` to propagate these new fields.

### Tool Handler: `test_connection`

**Remote server** (`src/remote/server.ts`):
```typescript
toolHandlers.test_connection = async (input, routes, context) => {
  const { connection } = input as { connection: string };
  // 1. Find the resolved route matching this connection alias
  // 2. If no testConnection config → return { supported: false, connection }
  // 3. Build the test request from testConnection config
  // 4. Execute via executeProxyRequest() (reuses existing route matching + secret injection)
  // 5. Compare response status to expectedStatus (default [200])
  // 6. Return { success, connection, status, statusText, description, message }
};
```

**MCP proxy** (`src/mcp/server.ts`): New `test_connection` MCP tool that forwards to the remote handler.

### Files to Modify

- `src/shared/config.ts` — Add `TestConnectionConfig` interface, add `testConnection?` to `Route`, extend `ResolvedRoute` with `alias` + new fields, update `resolveRoutes()`
- `src/connections/*.json` — Add `testConnection` block to all 22 templates
- `src/remote/server.ts` — Add `test_connection` tool handler
- `src/mcp/server.ts` — Add `test_connection` MCP tool
- `src/shared/connections.ts` — Update `ConnectionTemplateInfo` to include `hasTestConnection`

---

## 2. Test Event Listener

### Concept

Each connection that has an ingestor can optionally define a `testIngestor` block — a lightweight verification that the listener's configuration and credentials are correct. The behavior depends on the ingestor type:

- **WebSocket ingestors** (Discord, Slack): Hit a lightweight API endpoint that verifies the token is valid for gateway/socket-mode access.
- **Webhook ingestors** (GitHub, Stripe, Trello): Verify required secrets are configured and optionally hit the service's webhook listing API.
- **Poll ingestors**: Execute a single poll request and verify the response shape.

Connections that can't be meaningfully tested set `testIngestor: null` explicitly.

### Schema Addition

```typescript
/** Pre-configured test for verifying ingestor/listener configuration. */
interface TestIngestorConfig {
  /** Human-readable description of what this test verifies. */
  description: string;
  /** Strategy for testing. */
  strategy: 'websocket_auth' | 'webhook_verify' | 'poll_once' | 'http_request';
  /** For 'http_request' / 'websocket_auth' strategy: an HTTP request to verify. */
  request?: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    expectedStatus?: number[];
  };
  /** For 'webhook_verify' strategy: secret names that must be present and non-empty. */
  requireSecrets?: string[];
}
```

### Per-Connection Test Configurations

| Connection | Strategy | What It Does |
|---|---|---|
| **discord-bot** | `websocket_auth` | `GET https://discord.com/api/v10/gateway/bot` — verifies bot token has gateway access |
| **slack** | `http_request` | `POST https://slack.com/api/apps.connections.open` with `Authorization: Bearer ${SLACK_APP_TOKEN}` — verifies Socket Mode app token |
| **github** | `webhook_verify` | Checks that `GITHUB_WEBHOOK_SECRET` is set and non-empty |
| **stripe** | `webhook_verify` | Checks that `STRIPE_WEBHOOK_SECRET` is set and non-empty |
| **trello** | `http_request` | `GET https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}` — lists registered webhooks |
| **notion** | `poll_once` | Executes one poll request, validates response has `results` array |
| **linear** | `poll_once` | Executes one poll request, validates response shape |
| **reddit** | `poll_once` | Executes one poll cycle |
| **telegram-bot** | `poll_once` | Executes one poll cycle |
| **twitch** | `poll_once` | Executes one poll cycle |
| **mastodon** | `poll_once` | Executes one poll cycle |
| **bluesky** | `poll_once` | Executes one poll cycle |
| **x** | `poll_once` | Executes one poll cycle |
| All without ingestors | `null` / omitted | No ingestor, no test |

### Tool Handler: `test_ingestor`

**Remote server**:
```typescript
toolHandlers.test_ingestor = async (input, routes, context) => {
  const { connection } = input as { connection: string };
  // 1. Find the resolved route + testIngestor config
  // 2. If no ingestor → return { supported: false, reason: 'no ingestor' }
  // 3. If testIngestor is null → return { supported: false, reason: 'not testable' }
  // 4. Based on strategy:
  //    - 'websocket_auth': Execute the HTTP request that verifies gateway/socket auth
  //    - 'webhook_verify': Check that all requireSecrets are non-empty in resolved secrets
  //    - 'poll_once': Execute a single HTTP request using the poll config URL + headers
  //    - 'http_request': Execute the configured request, check status
  // 5. Return { success, connection, strategy, description, message, details? }
};
```

### Files to Modify

- `src/shared/config.ts` — Add `TestIngestorConfig` interface, add `testIngestor?` to `Route`
- `src/remote/ingestors/types.ts` — Export `TestIngestorConfig` from here as well (co-located with ingestor types)
- `src/connections/*.json` — Add `testIngestor` to connections with ingestors
- `src/remote/server.ts` — Add `test_ingestor` tool handler
- `src/mcp/server.ts` — Add `test_ingestor` MCP tool

---

## 3. Configurable Event Listeners

### Concept

Integrating systems need to configure what an event listener listens to — which Trello board, which Discord channels, which events to filter. Today, `IngestorOverrides` handles some of this but it's hardcoded per-type and not self-describing.

We introduce **`listenerConfig`**: each connection template declares a schema of configurable parameters with types, labels, descriptions, defaults, and validation — enough for any frontend to render a form.

### Schema: `ListenerConfigField` and `ListenerConfigSchema`

**New file: `src/remote/ingestors/listener-config-schema.ts`**

```typescript
/** A single configurable field for an event listener. */
interface ListenerConfigField {
  /** Machine-readable key (e.g., "boardId", "eventFilter"). */
  key: string;
  /** Human-readable label (e.g., "Trello Board"). */
  label: string;
  /** Help text / description. */
  description?: string;
  /** Whether this field must be set. */
  required?: boolean;

  /** The input type — determines how a UI renders this. */
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'secret' | 'text[]';

  /** Default value (if any). */
  default?: string | number | boolean | string[];

  /** For 'select' and 'multiselect': the available options. */
  options?: Array<{
    value: string | number | boolean;
    label: string;
    description?: string;
  }>;

  /** For 'text': placeholder text. */
  placeholder?: string;

  /** For 'number': min/max constraints. */
  min?: number;
  max?: number;

  /** For 'text': regex pattern for validation. */
  pattern?: string;

  /**
   * For dynamic options that must be fetched from the API.
   * A UI calls `resolve_listener_options` with this param key
   * and the server executes this request, returning options.
   */
  dynamicOptions?: {
    url: string;
    method?: string;
    body?: unknown;
    responsePath?: string;
    labelField: string;
    valueField: string;
  };

  /** Which IngestorOverrides key this maps to. If omitted, uses `key` directly. */
  overrideKey?: string;

  /** Group label for organizing fields in UIs (e.g., "Filtering", "Advanced"). */
  group?: string;
}

/** Complete listener config schema for a connection. */
interface ListenerConfigSchema {
  name: string;
  description?: string;
  fields: ListenerConfigField[];
}
```

### Per-Connection Listener Parameters

| Connection | Key Parameters |
|---|---|
| **discord-bot** | `eventFilter` (multiselect: MESSAGE_CREATE, MESSAGE_UPDATE, etc.), `guildIds` (text[], dynamic from `/users/@me/guilds`), `channelIds` (text[]), `userIds` (text[]), `intents` (number), `bufferSize` (number) |
| **slack** | `eventFilter` (multiselect: message, reaction_added, etc.), `bufferSize` (number) |
| **github** | `eventFilter` (multiselect: push, pull_request, issues, etc.), `bufferSize` (number) |
| **stripe** | `eventFilter` (multiselect: charge.succeeded, invoice.paid, etc.), `bufferSize` (number) |
| **trello** | `boardId` (text, required, dynamic from API), `eventFilter` (multiselect: updateCard, createCard, etc.), `bufferSize` (number) |
| **notion** | `intervalMs` (number, default 60000), `bufferSize` (number) |
| **linear** | `intervalMs` (number), `bufferSize` (number) |
| **telegram-bot** | `allowedUpdates` (multiselect), `intervalMs` (number), `bufferSize` (number) |
| **reddit** | `subreddit` (text, required), `intervalMs` (number), `bufferSize` (number) |
| **twitch** | `channelIds` (text[]), `intervalMs` (number), `bufferSize` (number) |
| **mastodon** | `intervalMs` (number), `bufferSize` (number) |
| **bluesky** | `intervalMs` (number), `bufferSize` (number) |
| **x** | `intervalMs` (number), `bufferSize` (number) |

### Where Values Live in Caller Config

In `remote.config.json`, callers set values via `ingestorOverrides` — we extend `IngestorOverrides` with a generic `params` bag:

```json
{
  "callers": {
    "my-laptop": {
      "connections": ["trello"],
      "ingestorOverrides": {
        "trello": {
          "params": {
            "boardId": "abc123def456",
            "eventFilter": ["updateCard", "createCard"]
          }
        }
      }
    }
  }
}
```

### How `params` Flow to Ingestors

`IngestorManager.mergeIngestorConfig()` already merges `IngestorOverrides` into ingestor configs. We extend it to map well-known `params` keys to their typed config fields:

- `params.eventFilter` → `websocket.eventFilter` or `webhook.eventFilter`
- `params.guildIds` → `websocket.guildIds`
- `params.channelIds` → `websocket.channelIds`
- `params.userIds` → `websocket.userIds`
- `params.intents` → `websocket.intents`
- `params.intervalMs` → `poll.intervalMs`
- `params.boardId` → stored for webhook registration use
- etc.

This mapping uses the `overrideKey` from the schema, falling back to direct key matching.

### Tool Handlers

**`list_listener_configs`** — Returns the schema for all connections that have configurable listeners:

```typescript
toolHandlers.list_listener_configs = async (_input, routes, context) => {
  // Return listenerConfig schemas for all routes that have them,
  // along with current values from the caller's ingestorOverrides
};
```

**`resolve_listener_options`** — For dynamic options (like fetching Trello boards), fetches options from the API:

```typescript
toolHandlers.resolve_listener_options = async (input, routes, context) => {
  const { connection, paramKey } = input;
  // 1. Find the param with dynamicOptions
  // 2. Execute the API request using caller's secrets
  // 3. Extract options from response using responsePath, labelField, valueField
  // 4. Return the options array
};
```

### Files to Modify/Create

- **New:** `src/remote/ingestors/listener-config-schema.ts` — types + validation
- `src/shared/config.ts` — Add `ListenerConfigSchema` to `Route`, `listenerConfig?` to `ResolvedRoute`, add `params?: Record<string, unknown>` to `IngestorOverrides`
- `src/connections/*.json` — Add `listenerConfig` to all connections with ingestors
- `src/remote/server.ts` — Add `list_listener_configs` and `resolve_listener_options` tool handlers
- `src/mcp/server.ts` — Add corresponding MCP tools
- `src/remote/ingestors/manager.ts` — Extend `mergeIngestorConfig` to apply `params` values

---

## 4. Listener Enable/Disable (Runtime Start/Stop)

### Concept

Today, ingestors start on boot via `IngestorManager.startAll()` and stop on shutdown. The `disabled` flag in `IngestorOverrides` is checked only at startup. We need runtime control — start, stop, and restart individual ingestors via MCP tools.

### New IngestorManager Methods

```typescript
class IngestorManager {
  /** Start a single ingestor for a caller+connection pair. */
  async startOne(callerAlias: string, connectionAlias: string): Promise<IngestorStatus>;

  /** Stop a single ingestor (preserves config for restart). */
  async stopOne(callerAlias: string, connectionAlias: string): Promise<IngestorStatus>;

  /** Stop then start — used after config changes. */
  async restartOne(callerAlias: string, connectionAlias: string): Promise<IngestorStatus>;

  /** Check if an ingestor exists (running or stopped). */
  has(callerAlias: string, connectionAlias: string): boolean;
}
```

### What Stop/Start Means Per Ingestor Type

| Type | On Stop | On Start |
|---|---|---|
| **WebSocket** (Discord) | Close WS connection, stop heartbeat. Events stop. | Reconnect to gateway, re-identify, resume event flow. |
| **WebSocket** (Slack) | Close Socket Mode connection. | Re-call `apps.connections.open`, reconnect. |
| **Webhook** (GitHub, Stripe, Trello) | Unregister from webhook dispatch map. Incoming POSTs for this caller return 404. External webhook registration is unaffected — events are silently dropped. | Re-register in dispatch map. Resume processing incoming webhooks. |
| **Poll** (Notion, Linear, etc.) | Clear polling interval. No HTTP requests. | Restart polling at configured interval. |

### BaseIngestor Re-entrant Lifecycle

Ensure `BaseIngestor.start()` is safe to call after `stop()`. Currently the base class has a state machine (`stopped → starting → connected → stopped`). We need to verify all subclasses reset their state cleanly in `stop()` so they can be `start()`ed again.

### Tool Handler: `control_listener`

```typescript
toolHandlers.control_listener = async (input, _routes, context) => {
  const { connection, action } = input as {
    connection: string;
    action: 'start' | 'stop' | 'restart';
  };
  const mgr = context.ingestorManager;
  switch (action) {
    case 'start': return mgr.startOne(context.callerAlias, connection);
    case 'stop': return mgr.stopOne(context.callerAlias, connection);
    case 'restart': return mgr.restartOne(context.callerAlias, connection);
  }
};
```

### MCP Tool

```typescript
server.tool(
  'control_listener',
  'Start, stop, or restart an event listener for a connection.',
  {
    connection: z.string().describe('Connection alias (e.g., "discord-bot")'),
    action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action'),
  },
  async ({ connection, action }) => { ... }
);
```

### Files to Modify

- `src/remote/ingestors/manager.ts` — Add `startOne()`, `stopOne()`, `restartOne()`, `has()`
- `src/remote/ingestors/base-ingestor.ts` — Verify re-entrant lifecycle; reset state in `stop()`
- `src/remote/server.ts` — Add `control_listener` tool handler
- `src/mcp/server.ts` — Add `control_listener` MCP tool

---

## 5. Gap Analysis: What Else Is Missing

### 5a. Webhook Registration Management

**Problem**: For webhook-based ingestors (GitHub, Stripe, Trello), the webhook must be registered with the external service. Currently this is done out-of-band. Trello is the only one that can be registered programmatically via API.

**Recommendation**: Add an optional `webhookRegistration` config to webhook connection templates:

```typescript
interface WebhookRegistrationConfig {
  strategy: 'manual' | 'api';
  instructions?: string;              // For 'manual': human-readable setup instructions
  register?: { method: string; url: string; body?: unknown; };
  deregister?: { method: string; url: string; };
  list?: { method: string; url: string; responsePath?: string; };
}
```

Add `register_webhook` / `deregister_webhook` / `list_webhooks` tool handlers. For `manual` strategy connections, return the instructions text.

### 5b. Bulk Test Tools

Add `test_all_connections` and `test_all_ingestors` tools that run tests across all the caller's connections and return a summary table. These are simple orchestration over the single-connection tools.

### 5c. Runtime Config Persistence

When `update_listener_config` changes params at runtime, those changes are in-memory only and lost on server restart. Add an optional `persist: true` flag that writes the updated `ingestorOverrides` back to `remote.config.json`.

### 5d. Enhanced `list_routes` Response

Extend `list_routes` to include ingestor metadata alongside route info:

```json
{
  "name": "Discord Bot API",
  "hasIngestor": true,
  "ingestorType": "websocket",
  "ingestorState": "connected",
  "hasTestConnection": true,
  "hasTestIngestor": true,
  "hasListenerConfig": true,
  "listenerParamKeys": ["eventFilter", "guildIds", "channelIds", "intents", "bufferSize"]
}
```

### 5e. Config Validation at Startup

When the server starts, validate all caller `ingestorOverrides.params` against the `listenerConfig` schemas. Log warnings for invalid values, missing required fields, or unknown keys.

### 5f. Ingestor Event: Config Applied

When listener config changes at runtime, emit an audit log entry and optionally push a system event into the ring buffer so polling clients know the listener was reconfigured.

---

## 6. Implementation Order

### Phase 1: Foundation (Types + ResolvedRoute)
1. Add all new interfaces to `src/shared/config.ts`
2. Extend `ResolvedRoute` with `alias`, `testConnection`, `testIngestor`, `listenerConfig`, `ingestorConfig`
3. Update `resolveRoutes()` / `resolveCallerRoutes()` to carry new fields through
4. Create `src/remote/ingestors/listener-config-schema.ts` with types
5. Add `params?: Record<string, unknown>` to `IngestorOverrides`

### Phase 2: Test Connection
1. Add `testConnection` to all 22 connection templates
2. Add `test_connection` tool handler on remote server
3. Add `test_connection` MCP tool on proxy
4. Tests

### Phase 3: Test Ingestor
1. Add `testIngestor` to connection templates with ingestors
2. Add `test_ingestor` tool handler + MCP tool
3. Implement per-strategy test logic
4. Tests

### Phase 4: Listener Configuration
1. Add `listenerConfig` schemas to connection templates with ingestors
2. Add `list_listener_configs` and `resolve_listener_options` tool handlers + MCP tools
3. Extend `mergeIngestorConfig` to apply `params`
4. Add config validation
5. Add `update_listener_config` tool handler + MCP tool
6. Tests

### Phase 5: Runtime Lifecycle
1. Add `startOne()` / `stopOne()` / `restartOne()` to `IngestorManager`
2. Ensure `BaseIngestor.start()` is re-entrant after `stop()`
3. Add `control_listener` tool handler + MCP tool
4. Extend `list_routes` with ingestor metadata
5. Tests

### Phase 6: Webhook Registration (Stretch)
1. Add `webhookRegistration` config to applicable templates
2. Add `register_webhook` / `deregister_webhook` / `list_webhooks` tool handlers
3. Tests

---

## 7. New MCP Tools Summary

| Tool | Description | Phase |
|---|---|---|
| `test_connection` | Test API credentials for a connection | 2 |
| `test_ingestor` | Test event listener config for a connection | 3 |
| `list_listener_configs` | Get configurable params schema for all listeners | 4 |
| `resolve_listener_options` | Fetch dynamic options for a listener param | 4 |
| `update_listener_config` | Update listener configuration at runtime | 4 |
| `control_listener` | Start/stop/restart an event listener | 5 |
| `register_webhook` | Register a webhook with the external service | 6 |
| `deregister_webhook` | Remove a webhook registration | 6 |
| `list_webhooks` | List registered webhooks for a connection | 6 |

## 8. Files Summary

### Modified
- `src/shared/config.ts` — `Route`, `ResolvedRoute`, `IngestorOverrides`, `resolveRoutes()`, `resolveCallerRoutes()`
- `src/remote/ingestors/types.ts` — Co-export `TestIngestorConfig`
- `src/remote/ingestors/manager.ts` — `startOne`, `stopOne`, `restartOne`, extend `mergeIngestorConfig`
- `src/remote/ingestors/base-ingestor.ts` — Verify re-entrant lifecycle
- `src/remote/server.ts` — 6+ new tool handlers
- `src/mcp/server.ts` — 6+ new MCP tool registrations
- `src/connections/*.json` — All 22 templates updated
- `src/shared/connections.ts` — Update `ConnectionTemplateInfo`

### Created
- `src/remote/ingestors/listener-config-schema.ts` — Schema types + validation utilities

### Tests
- Tests for new tool handlers in `src/remote/server.test.ts`
- Tests for lifecycle methods in `src/remote/ingestors/manager.test.ts`
- Tests for config validation in `src/remote/ingestors/listener-config-schema.test.ts`
