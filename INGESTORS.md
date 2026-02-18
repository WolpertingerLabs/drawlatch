# Ingestors: Real-Time Data Collection for MCP Secure Proxy

> **Status:** Phase 1 (Core Infrastructure + Discord Gateway) — **Complete**
> **Date:** 2026-02-18

---

## Overview

Ingestors add **real-time data pull** capability to mcp-secure-proxy. Previously the system was purely request/response — Claude could push HTTP requests out to APIs but could not receive asynchronous incoming data. Services like Discord, Slack, and GitHub offer real-time streams (WebSocket gateways, webhooks, event APIs) that can proactively feed data into the system.

Ingestors are **long-lived data collectors** running on the remote server that buffer incoming events in per-caller ring buffers. Claude polls for new events through the existing encrypted MCP channel using `poll_events` and `ingestor_status` tools.

### Design Principles

- **Zero secrets on the client** — ingestors run server-side; tokens never leave the remote process
- **Per-caller isolation** — each caller gets its own ingestor instances with their own buffers and connection state
- **No new dependencies** — uses native WebSocket (Node 22+) and existing infrastructure
- **Backward compatible** — existing tool handlers and test patterns are preserved
- **Connection-centric** — ingestor config lives in connection templates alongside route definitions

---

## Architecture

```
                                        ┌─────────────────────┐
                                        │  Discord Gateway WS  │
                                        └──────────┬──────────┘
                                                   │ real-time events
┌──────────────┐   encrypted    ┌──────────────────▼───────────────┐
│  Claude Code │◄── poll ──────│  Remote Server                    │
│  (MCP Proxy) │               │  ┌────────────┐  ┌─────────────┐ │
│              │               │  │ Discord GW  │  │ Ring Buffer │ │
│  poll_events │── encrypted ─►│  │ Ingestor    ├─►│ per-caller  │ │
│              │               │  └────────────┘  └─────────────┘ │
└──────────────┘               └──────────────────────────────────┘
```

### Data Flow

1. **Startup**: Remote server creates an `IngestorManager`, which iterates all callers and their connections. For each connection with an `ingestor` config block, it creates the appropriate ingestor instance.
2. **Ingestion**: The ingestor connects to the external service (e.g., Discord Gateway WebSocket), authenticates using resolved secrets, and streams events into a per-caller ring buffer.
3. **Polling**: Claude calls `poll_events` (through the MCP proxy → encrypted channel → remote server). The remote server retrieves events from the ring buffer since the caller's last cursor and returns them.
4. **Status**: Claude calls `ingestor_status` to check connection health, buffer sizes, and error states.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Ingestors are per-server, not per-session | Multiple Claude sessions from the same caller share the same ingestor/buffer, avoiding duplicate connections |
| Ring buffer (not unbounded queue) | Bounded memory usage; oldest events evict naturally. Default 200, max 1000 |
| Cursor-based polling (`after_id`) | Stateless on the client side; Claude just tracks the last event ID it saw |
| Config in connection templates | Keeps ingestor config co-located with the connection it belongs to |
| Native WebSocket (Node 22+) | Zero npm dependency additions |
| `ToolContext` third parameter | Backward-compatible — existing handlers ignore the extra arg |

---

## What Was Implemented

### New Files

| File | Purpose |
|---|---|
| `src/remote/ingestors/types.ts` | All shared types: `IngestorConfig`, `IngestedEvent`, `IngestorStatus`, `IngestorState`, config interfaces for websocket/webhook/poll, constants |
| `src/remote/ingestors/ring-buffer.ts` | Generic bounded circular buffer with `push()`, `toArray()`, `since(afterId)`, `size`, `clear()` |
| `src/remote/ingestors/base-ingestor.ts` | Abstract base class extending `EventEmitter`. Owns ring buffer, tracks state/counters, provides `pushEvent()`, `getEvents()`, `getStatus()` |
| `src/remote/ingestors/manager.ts` | `IngestorManager` — lifecycle management keyed by `callerAlias:connectionAlias`. Provides `startAll()`, `stopAll()`, `getEvents()`, `getAllEvents()`, `getStatuses()` |
| `src/remote/ingestors/discord-gateway.ts` | Full Discord Gateway v10 WebSocket implementation with heartbeat, resume, reconnect, event filtering |
| `src/remote/ingestors/index.ts` | Barrel exports |
| `src/remote/ingestors/ring-buffer.test.ts` | 11 unit tests covering ordering, eviction, wrapping, cursors, edge cases |
| `src/remote/ingestors/manager.test.ts` | 4 unit tests covering empty states and lifecycle |

### Modified Files

| File | Changes |
|---|---|
| `src/remote/server.ts` | Added `ToolContext` interface, updated `ToolHandler` type signature, added `poll_events` and `ingestor_status` handlers, integrated `IngestorManager` into `createApp()`, lifecycle hooks in `main()`/`shutdown()`, DI support via `CreateAppOptions` |
| `src/mcp/server.ts` | Registered `poll_events` and `ingestor_status` MCP tools that delegate through the encrypted channel |
| `src/shared/config.ts` | Added `ingestor?: IngestorConfig` field to `Route` interface |
| `src/connections/discord-bot.json` | Added ingestor config block with Discord Gateway WebSocket settings |
| `src/remote/server.e2e.test.ts` | Added 4 e2e tests for `poll_events` and `ingestor_status` tools |

---

## Component Details

### Ring Buffer (`ring-buffer.ts`)

A generic `RingBuffer<T>` with fixed capacity. When full, the oldest item is silently evicted. Uses a circular array with head pointer and count for O(1) push.

- **`push(item)`** — Write at head, advance, evict if full
- **`toArray()`** — Returns all items in chronological order (oldest first)
- **`since(afterId)`** — Cursor-based retrieval: returns items where `item.id > afterId`
- **`size`** — Current item count
- **`clear()`** — Resets buffer without changing capacity

### Base Ingestor (`base-ingestor.ts`)

Abstract class that all ingestor types extend. Provides:

- **State machine**: `stopped` → `starting` → `connected` (↔ `reconnecting`) → `stopped` | `error`
- **Ring buffer**: Per-instance `RingBuffer<IngestedEvent>` (default capacity 200)
- **Event counting**: `totalEventsReceived` counter (monotonic, survives buffer evictions)
- **`pushEvent(eventType, data)`**: Creates an `IngestedEvent` with auto-incrementing ID and ISO timestamp, pushes to buffer, emits `'event'`
- **`getEvents(afterId)`**: Retrieves buffered events since cursor
- **`getStatus()`**: Returns `IngestorStatus` snapshot

### Ingestor Manager (`manager.ts`)

Singleton per remote server. Keyed by `callerAlias:connectionAlias`.

- **`startAll()`**: Called once at server startup. Iterates `config.callers`, resolves routes and secrets, creates ingestor instances for connections with `ingestor` config
- **`stopAll()`**: Graceful shutdown of all ingestors (called during server shutdown)
- **`getEvents(callerAlias, connectionAlias, afterId)`**: Events for a specific connection
- **`getAllEvents(callerAlias, afterId)`**: Events across all ingestors for a caller, sorted chronologically
- **`getStatuses(callerAlias)`**: Status of all ingestors for a caller
- **Factory**: `createIngestor()` dispatches to `DiscordGatewayIngestor` based on `config.type` and `config.websocket.protocol`

### Discord Gateway Ingestor (`discord-gateway.ts`)

Full implementation of the [Discord Gateway v10](https://discord.com/developers/docs/events/gateway) protocol:

**Lifecycle:**
1. `connect(url)` — Opens native WebSocket to `wss://gateway.discord.gg/?v=10&encoding=json`
2. Server sends `HELLO` with heartbeat interval
3. Client starts heartbeat with jitter, sends `IDENTIFY` (or `RESUME` if reconnecting)
4. Server sends `READY` with session ID and resume URL
5. Dispatch events flow in continuously

**Features:**
- **Heartbeat**: Initial jitter delay, then fixed interval. Tracks ACKs; zombie detection triggers reconnect
- **Resume**: Stores `session_id`, `sequence`, and `resume_gateway_url` from `READY`. On reconnect, sends `RESUME` instead of `IDENTIFY` to replay missed events
- **Reconnect**: Exponential backoff (1s → 30s max), up to 10 attempts
- **Close code handling**: Non-recoverable codes (4004, 4010-4014) → permanent error. Session-invalidating codes (4007, 4009) → clear session, re-identify
- **Invalid Session**: Resumable → wait 1-5s then resume. Not resumable → clear session, re-identify
- **Event filtering**: `eventFilter` array in config; empty = capture all
- **Intents**: Configurable via config, default `4609` = `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES`

**Exported:**
- `DiscordGatewayIngestor` class
- `DiscordIntents` const (all intent flags for easy composition)

### MCP Tool Registrations

**`poll_events`** (in `src/mcp/server.ts`):
```
Parameters:
  connection? (string) — filter by connection alias, omit for all
  after_id? (number)   — cursor; returns events with id > after_id
```
Delegates through `sendEncryptedRequest('poll_events', ...)` to the remote server's `poll_events` handler.

**`ingestor_status`** (in `src/mcp/server.ts`):
```
Parameters: none
```
Returns status of all ingestors for the calling user. Includes connection state, buffer sizes, event counts, errors.

### Connection Template (`discord-bot.json`)

Added `ingestor` block:
```json
{
  "ingestor": {
    "type": "websocket",
    "websocket": {
      "gatewayUrl": "wss://gateway.discord.gg/?v=10&encoding=json",
      "protocol": "discord",
      "intents": 4609
    }
  }
}
```

The intents value `4609` represents non-privileged intents: `GUILDS (1) | GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096)`. Users needing `MESSAGE_CONTENT` (privileged) would use `4609 | 32768 = 37377` and enable the intent in their Discord Developer Portal.

---

## Test Coverage

### Ring Buffer (`ring-buffer.test.ts`) — 11 tests
- Push and retrieve in correct order
- Evicts oldest items when over capacity
- Wraps correctly with interleaved push/read
- Returns empty array when empty
- Works with capacity of 1
- `since()` returns events after cursor
- `since(-1)` returns all events
- `since()` past all items returns empty
- `clear()` removes all items
- Handles exact capacity fill
- `since()` handles non-numeric IDs gracefully

### Manager (`manager.test.ts`) — 4 tests
- Returns empty events for caller with no ingestors
- Returns empty for unknown caller
- Handles connections without ingestor config
- Start/stop lifecycle

### E2E (`server.e2e.test.ts`) — 4 tests
- `poll_events` returns empty array when no ingestors configured
- `poll_events` with connection filter returns empty array
- `poll_events` with `after_id` cursor returns empty array
- `ingestor_status` returns empty array when no ingestors configured

### Build Verification
- `npm run build` — TypeScript compiles cleanly
- `npm test` — 139 tests pass (2 pre-existing suite failures unrelated to ingestors)
- `npm run lint` — No lint errors

---

## Future Work

### Phase 2: Webhook Ingestor

Add support for receiving HTTP webhooks from services like GitHub, Stripe, and Linear.

**Implementation:**
- Create `src/remote/ingestors/webhook-ingestor.ts`
- Add Express route: `POST /webhooks/:connectionAlias` on the remote server
- Signature verification using the connection's `signatureSecret` and `signatureHeader` config
- GitHub: `X-Hub-Signature-256` header, HMAC-SHA256 verification
- Stripe: `Stripe-Signature` header, timing-safe comparison
- Push verified payloads into the ring buffer via `pushEvent()`

**Config example (GitHub):**
```json
{
  "ingestor": {
    "type": "webhook",
    "webhook": {
      "path": "github",
      "signatureHeader": "X-Hub-Signature-256",
      "signatureSecret": "GITHUB_WEBHOOK_SECRET"
    }
  }
}
```

**Considerations:**
- The remote server needs to be publicly accessible for webhooks (or behind a tunnel)
- May need per-service signature verification strategies (pluggable verifier pattern)
- Rate limiting on the webhook endpoint to prevent abuse

### Phase 3: Polling Ingestor

Generic interval-based HTTP polling for APIs without real-time support (e.g., Notion, Jira, RSS feeds).

**Implementation:**
- Create `src/remote/ingestors/poll-ingestor.ts`
- Configurable interval, HTTP method, request body, and deduplication field
- Uses the existing `fetch` infrastructure with resolved secrets/headers from the connection
- Deduplication: track seen IDs to avoid pushing duplicate events

**Config example (Notion):**
```json
{
  "ingestor": {
    "type": "poll",
    "poll": {
      "url": "https://api.notion.com/v1/search",
      "intervalMs": 60000,
      "method": "POST",
      "body": { "sort": { "direction": "descending", "timestamp": "last_edited_time" } },
      "deduplicateBy": "id"
    }
  }
}
```

### Phase 4: Slack Socket Mode

Second WebSocket protocol implementation for Slack real-time events.

**Implementation:**
- Add `protocol: 'slack'` to `WebSocketIngestorConfig`
- Create `src/remote/ingestors/slack-socket.ts`
- Slack Socket Mode uses a different handshake: POST to `apps.connections.open` to get a WSS URL, then connect
- Events require acknowledgment (`acknowledge` envelope)
- Map Slack event types to `IngestedEvent`

### Phase 5: Caller-Level Ingestor Overrides

Allow callers to customize ingestor behavior without modifying connection templates.

**Implementation:**
- Add `ingestorOverrides` to `CallerConfig` in `config.ts`:
  ```typescript
  interface CallerConfig {
    // existing fields...
    ingestorOverrides?: Record<string, {
      /** Override buffer size for this connection's ingestor. */
      bufferSize?: number;
      /** Override event filter for this connection's ingestor. */
      eventFilter?: string[];
      /** Disable the ingestor for this connection entirely. */
      disabled?: boolean;
    }>;
  }
  ```
- `IngestorManager.startAll()` merges overrides with connection template config
- Useful for: limiting buffer size for low-memory deployments, filtering to specific event types per-caller, disabling ingestors for callers that don't need them

### Phase 6: Token Deduplication / Shared Connections

When multiple callers use the same bot token (same `DISCORD_BOT_TOKEN`), they currently each get their own Gateway connection. Discord rate-limits `IDENTIFY` (max 1 per 5 seconds per token), so this doesn't scale.

**Implementation:**
- Detect when multiple callers resolve to the same token for the same connection template
- Share a single Gateway connection, fan out events to per-caller ring buffers
- Reference counting for start/stop lifecycle
- Per-caller event filters still apply independently

### Phase 7: Event Payload Optimization

Large Discord events (e.g., `GUILD_CREATE` with thousands of members) can consume significant memory in the ring buffer.

**Implementation:**
- Configurable field stripping: remove unnecessary nested objects before buffering
- Payload size limits with truncation
- Optional compression for large payloads
- Summary mode: store event metadata only, fetch full payload on demand via API

### Phase 8: Persistent Cursors

Currently, if Claude's session restarts, it loses its `after_id` cursor and may re-process events still in the buffer.

**Implementation:**
- Store last-seen cursor per caller in a lightweight persistence layer (file or SQLite)
- New tool parameter: `resume: true` to automatically start from the last acknowledged cursor
- Acknowledgment: `ack_events` tool to explicitly mark events as processed

### Other Ideas

- **Event transformation pipelines**: Pre-process events before buffering (e.g., extract message content, resolve user IDs)
- **Event routing**: Route specific event types to specific tools automatically (e.g., `MESSAGE_CREATE` → auto-invoke a handler)
- **Metrics/observability**: Prometheus-style metrics for event rates, buffer utilization, connection uptime
- **Health check endpoint**: HTTP endpoint for monitoring ingestor health externally
- **Configurable reconnect strategies**: Per-ingestor max retries, backoff curves, circuit breaker patterns

---

## Configuration Reference

### Connection Template Ingestor Block

```json
{
  "name": "Service Name",
  "description": "...",
  "allowedEndpoints": ["..."],
  "headers": { "..." },
  "secrets": { "..." },
  "ingestor": {
    "type": "websocket | webhook | poll",
    "websocket": {
      "gatewayUrl": "wss://...",
      "protocol": "discord",
      "eventFilter": ["MESSAGE_CREATE", "MESSAGE_UPDATE"],
      "intents": 4609
    }
  }
}
```

### Discord Intent Values

| Intent | Value | Privileged |
|---|---|---|
| `GUILDS` | `1` | No |
| `GUILD_MEMBERS` | `2` | **Yes** |
| `GUILD_MODERATION` | `4` | No |
| `GUILD_EXPRESSIONS` | `8` | No |
| `GUILD_INTEGRATIONS` | `16` | No |
| `GUILD_WEBHOOKS` | `32` | No |
| `GUILD_INVITES` | `64` | No |
| `GUILD_VOICE_STATES` | `128` | No |
| `GUILD_PRESENCES` | `256` | **Yes** |
| `GUILD_MESSAGES` | `512` | No |
| `GUILD_MESSAGE_REACTIONS` | `1024` | No |
| `GUILD_MESSAGE_TYPING` | `2048` | No |
| `DIRECT_MESSAGES` | `4096` | No |
| `DIRECT_MESSAGE_REACTIONS` | `8192` | No |
| `DIRECT_MESSAGE_TYPING` | `16384` | No |
| `MESSAGE_CONTENT` | `32768` | **Yes** |
| `GUILD_SCHEDULED_EVENTS` | `65536` | No |
| `AUTO_MODERATION_CONFIGURATION` | `1048576` | No |
| `AUTO_MODERATION_EXECUTION` | `2097152` | No |

**Default:** `4609` = `GUILDS (1) + GUILD_MESSAGES (512) + DIRECT_MESSAGES (4096)`

To include message content (privileged): `4609 | 32768 = 37377`

### Common Event Filters

For `eventFilter` in Discord WebSocket config:

| Filter | Description |
|---|---|
| `MESSAGE_CREATE` | New messages in channels the bot can see |
| `MESSAGE_UPDATE` | Message edits |
| `MESSAGE_DELETE` | Message deletions |
| `MESSAGE_REACTION_ADD` | Reactions added to messages |
| `MESSAGE_REACTION_REMOVE` | Reactions removed |
| `GUILD_MEMBER_ADD` | New member joins (requires GUILD_MEMBERS intent) |
| `GUILD_MEMBER_REMOVE` | Member leaves/kicked |
| `PRESENCE_UPDATE` | User status changes (requires GUILD_PRESENCES intent) |
| `TYPING_START` | User starts typing |
| `INTERACTION_CREATE` | Slash commands, buttons, modals |

Empty `eventFilter` (or omitted) captures all dispatch events.
