# Drawlatch

> **Alpha Software:** Expect breaking changes between updates.

Drawlatch is a config-driven proxy that gives AI agents authenticated access to external APIs. Define your connections and secrets in a single config file — agents get structured, allowlisted access to 23 pre-built APIs without ever seeing your credentials.

**Using [Callboard](https://github.com/WolpertingerLabs/callboard)?** Drawlatch is built in — Callboard manages connections, secrets, and agent identities through its UI. You don't need to set up drawlatch separately.

## Key Features

- **23 pre-built connections** — GitHub, Slack, Discord, Stripe, Notion, Linear, OpenAI, and [more](CONNECTIONS.md)
- **Endpoint allowlisting** — agents can only reach explicitly configured URL patterns
- **Per-caller access control** — each agent identity sees only its assigned connections
- **Real-time event ingestion** — WebSocket, webhook, and polling listeners for incoming events ([details](INGESTORS.md))
- **Two operating modes** — remote (secrets on a separate server with E2EE) or local (in-process library)

## How It Works

Drawlatch runs in two modes depending on your trust model:

### Remote Mode — Secrets Never Leave the Server

The local MCP proxy holds no secrets. It encrypts requests and forwards them to a remote server that injects credentials and makes the actual API calls.

```
┌──────────────┐                          ┌──────────────────┐                    ┌──────────────┐
│  Claude Code  │◄── stdio ──► MCP Proxy  │◄── HTTP + E2EE ──►  Remote Server    │── HTTPS ────►│  External API │
│              │              (no secrets) │                   │  (holds secrets)  │              │               │
└──────────────┘                          └──────────────────┘                    └──────────────┘
```

The crypto layer uses Ed25519 signatures for mutual authentication and X25519 ECDH to derive AES-256-GCM session keys — all built on Node.js native `crypto` with zero external dependencies.

### Local Mode — In-Process Library

No server, no encryption. Your application imports drawlatch directly and calls the same `executeProxyRequest()` function the remote server uses. Secrets come from `process.env` on the same machine.

```
┌──────────────────────────────────────────┐                    ┌──────────────┐
│  Your Application                        │── HTTPS ──────────►│  External API │
│  ┌──────────┐   in-process   ┌────────┐ │                    │               │
│  │  Agent   │◄── call ──────►│ drawl. │ │                    └──────────────┘
│  └──────────┘                └────────┘ │
└──────────────────────────────────────────┘
```

You still get config-driven route resolution, endpoint allowlisting, per-caller access control, and ingestor support — just without cryptographic secret isolation.

> **When to use which:** Remote mode when secrets must be hidden from the agent's machine (shared servers, CI, untrusted environments). Local mode when running on your own machine and you want convenience without a separate server.

## Quick Start

Get from zero to working in three commands:

```bash
# Install globally
npm install -g @wolpertingerlabs/drawlatch

# Set up keys, config, and .env in one step
drawlatch init --connections github

# Set your API token (edit the file or run this)
echo "GITHUB_TOKEN=ghp_your_token_here" >> ~/.drawlatch/.env

# Start the remote server
drawlatch start
```

Verify your setup:

```bash
drawlatch doctor    # Validate full setup
drawlatch status    # Check server is running
drawlatch config    # View configuration and secret status
```

The `init` command generates keys, creates configs, exchanges public keys, and scaffolds the `.env` file. All steps are idempotent — safe to re-run.

### Connect to Claude Code

**Option 1: Claude Code Plugin (Recommended)**

```shell
# Install the plugin
/plugin install drawlatch@drawlatch
```

The plugin's MCP server starts automatically. The proxy uses `~/.drawlatch/` by default — see [Advanced Configuration](#advanced-configuration) to use a custom path.

**Option 2: Auto-Discovery**

This repo includes a `.mcp.json` file, so Claude Code automatically discovers the MCP proxy when you open the project. Approve the server when prompted.

**Option 3: Manual Registration**

```bash
claude mcp add drawlatch \
  -e MCP_CONFIG_DIR=~/.drawlatch \
  -- node /path/to/drawlatch/dist/mcp/server.js
```

> **Note:** Auto-discovery and manual registration use `dist/mcp/server.js`. The `dist/` directory is built automatically via `npm install` (prepare script). Rebuild manually with `npm run build` if needed.

### Manual Setup

For custom setups (different aliases, multiple callers, different machines), you can configure everything manually instead of using `drawlatch init`.

**1. Generate keys:**

```bash
drawlatch generate-keys caller my-laptop
drawlatch generate-keys server
```

**2. Exchange public keys** — on separate machines, copy `*.pub.pem` files to the matching `keys/callers/<alias>/` or `keys/server/` directory on the other machine. See [Key Exchange](#key-exchange) for details.

**3. Create configs** — copy the example files and edit:

```bash
cp remote.config.example.json ~/.drawlatch/remote.config.json
cp proxy.config.example.json ~/.drawlatch/proxy.config.json
```

**4. Create a `.env` file** with your API secrets:

```bash
cat > ~/.drawlatch/.env << 'EOF'
# GITHUB_TOKEN=ghp_your_token_here
# DISCORD_BOT_TOKEN=your_bot_token_here
EOF
```

**5. Start the server:**

```bash
drawlatch start
drawlatch doctor    # Validate full setup
```

## Admin Dashboard

`drawlatch start` serves a built-in web dashboard — a React single-page app — for inspecting your running daemon: which connections exist, who can call them, which secrets are wired up, and what's happening live (sessions and event ingestors). It is a **read-only observability surface**: you browse and diagnose here, but you still edit config and secrets in `~/.drawlatch/` and via the CLI.

### Architecture

There is no separate UI service to run. The React app, the `/api/admin/*` API, and the MCP protocol endpoints (`/handshake`, `/request`, `/events`, `/webhooks`, …) are all served by the **same Express process on the same port** as the daemon (default `http://127.0.0.1:9999/`):

```
┌────────────────────────────── drawlatch daemon (one process, port 9999) ──────────────────────────────┐
│                                                                                                        │
│   GET /                 →  React SPA (served from frontend/dist in production)                          │
│   GET /api/admin/*      →  read-only JSON API  ──┐                                                      │
│   POST /api/auth/*      →  login / logout / check ├─ password-gated (session cookie)                    │
│   /handshake /request … →  MCP protocol (E2EE)   ─┘  ← unaffected by dashboard auth                     │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Any unmatched non-API GET falls back to `index.html` so client-side routing works. The MCP protocol endpoints are independent of the dashboard — they keep serving agents even when the dashboard is locked (see below).

### Setup

**1. Set a password** (required — the dashboard is locked until one is set):

```bash
drawlatch set-password          # prompts on a TTY, or reads a password piped on stdin
# echo 'my-strong-password' | drawlatch set-password   # non-interactive
```

The password is hashed with **scrypt** (random 16-byte salt, verified with a constant-time compare); the hash + salt are written to `~/.drawlatch/.env` (`AUTH_PASSWORD_HASH` / `AUTH_PASSWORD_SALT`, mode `0600`). Your plaintext password is never stored. Use `drawlatch change-password` (an alias of the same command) to rotate it later — rotating signs out every other session.

**2. Open the dashboard** at `http://127.0.0.1:9999/` and log in. `drawlatch status` prints the dashboard URL and whether a password is configured.

### Pages

| Page | Route | What it shows | Refresh |
|------|-------|---------------|---------|
| **Overview** | `/` | Daemon health at a glance: status, PID, port, version, uptime, active session count, ingestor state breakdown, and secrets-configured progress. | on load |
| **Connections** | `/connections` | All built-in + custom connection templates — name, category, stability, ingestor type, required-secret count. Click through for per-connection detail. | on load |
| **Callers** | `/callers` | Registered MCP callers — alias, name, connection count, key fingerprint, and whether their keys directory exists. Click through for a caller's connections and secret status. | on load |
| **Ingestors** | `/ingestors` | Live table of every running ingestor (WebSocket / webhook / poll) — state, buffered event count, total events received, last activity, and any error. | every 2s |
| **Sessions** | `/sessions` | Active MCP proxy sessions — caller alias, created/last-active times, request count, and current per-window request rate. | every 5s |
| **Secrets** | `/secrets` | A (caller × connection × secret) matrix showing required/optional and present/missing — with a "only missing" filter. **Never shows secret values**, only whether each is set. | every 10s |

### The `/api/admin/*` API

The pages are thin views over a small read-only JSON API (`/api/admin/meta`, `/health`, `/connections`, `/callers`, `/callers/:alias/connections`, `/ingestors`, `/sessions`, `/secrets`). Every endpoint is **GET-only and never returns a secret value** — caller `env` maps are reduced to key *names*, secret state is reported as booleans via a presence check, and session crypto material is never serialized. There are no mutating admin endpoints, by design.

### Security model

The **password is the trust boundary** for the dashboard and `/api/admin/*` — not loopback. That lets you expose the dashboard to a LAN by binding a non-loopback host:

```bash
DRAWLATCH_HOST=0.0.0.0 drawlatch start    # or: drawlatch start --host 0.0.0.0
```

Auth uses a `drawlatch_session` cookie that is `httpOnly` and `sameSite=strict`, with a **7-day rolling expiry** (every authenticated request extends it). Login, password-change, and auth-check endpoints are rate-limited per IP (5/min for login & change-password, 20/min for checks). If **no** password is configured, the daemon still starts and serves MCP normally — only the dashboard is locked: `/api/auth/*` and `/api/admin/*` return `503` and the SPA shows a locked state prompting `drawlatch set-password`. The daemon never exits just because the dashboard is unconfigured.

> **Cookies run over plain HTTP** on loopback/LAN (no `secure` flag). Put the daemon behind a TLS-terminating reverse proxy if you expose it beyond a trusted network.

> **Migrating from `drawlatch-ui`?** The standalone `drawlatch-ui` service and its `~/.drawlatch-ui/` config directory are abandoned — its dashboard, auth gate, and password now live inside drawlatch. There is no automatic migration: just run `drawlatch set-password` once to set the password in `~/.drawlatch/.env`.

## MCP Tools

Once connected, agents get these tools:

| Tool | Description |
|------|-------------|
| `secure_request` | Make authenticated HTTP requests. Route-level headers (auth tokens, API keys) are injected automatically — the agent never sees secret values. Supports JSON and multipart/form-data file uploads. |
| `list_routes` | Discover available APIs with metadata, docs links, allowed endpoints, and available secret placeholders. |
| `poll_events` | Retrieve buffered events from ingestors (Discord messages, GitHub webhooks, etc.) with cursor-based pagination. |
| `ingestor_status` | Get connection state, buffer sizes, event counts, and errors for all active ingestors. |
| `test_connection` | Verify API credentials with a pre-configured read-only request. |
| `control_listener` | Start, stop, or restart an event listener. |
| `list_listener_configs` | Get configurable fields for event listeners. |
| `set_listener_params` | Configure listener parameters (filters, buffer sizes, etc.). |
| `get_listener_params` | Read current listener parameter overrides. |
| `resolve_listener_options` | Fetch dynamic options for listener config fields (e.g., list of Trello boards). |
| `list_listener_instances` | List instances of a multi-instance listener. |
| `delete_listener_instance` | Remove a multi-instance listener instance. |
| `test_ingestor` | Test event listener configuration and credentials. |

## Configuration Reference

### Remote Server Config (`remote.config.json`)

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "connectors": [],
  "callers": {},
  "rateLimitPerMinute": 60
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `host` | Network interface to bind | `127.0.0.1` |
| `port` | Listen port | `9999` |
| `connectors` | Custom connector definitions (see below) | `[]` |
| `callers` | Per-caller access control (see below) | `{}` |
| `rateLimitPerMinute` | Max requests per minute per session | `60` |

Server keys are always loaded from `keys/server/` inside the config directory.

### Callers

Each caller is identified by their public key and declares which connections they can access:

```json
{
  "callers": {
    "alice": {
      "name": "Alice (senior engineer)",
      "connections": ["github", "stripe", "internal-api"],
      "env": {
        "GITHUB_TOKEN": "${ALICE_GITHUB_TOKEN}"
      }
    },
    "ci-server": {
      "name": "GitHub Actions CI",
      "connections": ["github"]
    }
  }
}
```

Caller public keys are loaded automatically from `keys/callers/<alias>/` — no path configuration needed.

| Field | Required | Description |
|-------|----------|-------------|
| `connections` | Yes | Array of connection names (built-in or custom connector aliases) |
| `name` | No | Human-readable name for audit logs |
| `env` | No | Per-caller env var overrides — redirect secret resolution per caller |
| `ingestorOverrides` | No | Per-caller ingestor config overrides ([details](INGESTORS.md#caller-level-ingestor-overrides)) |

The `env` map lets multiple callers share the same connection with different credentials:
- Keys are the env var names connectors reference (e.g., `GITHUB_TOKEN`)
- Values are `"${REAL_ENV_VAR}"` (redirect) or literal strings (direct injection)
- Checked before prefixed env vars during secret resolution

Without an explicit `env` mapping, secrets resolve via prefixed env vars (e.g., caller "alice" + `GITHUB_TOKEN` → `ALICE_GITHUB_TOKEN`).

### Custom Connectors

Define reusable route templates for APIs not covered by built-in connections:

```json
{
  "connectors": [
    {
      "alias": "internal-api",
      "name": "Internal Admin API",
      "allowedEndpoints": ["https://admin.internal.com/**"],
      "headers": { "Authorization": "Bearer ${ADMIN_KEY}" },
      "secrets": { "ADMIN_KEY": "${INTERNAL_ADMIN_KEY}" }
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `alias` | Yes | Unique name for referencing from caller `connections` lists |
| `allowedEndpoints` | Yes | Glob patterns for allowed URLs |
| `name` | No | Human-readable name |
| `description` | No | Short description |
| `docsUrl` | No | URL to API documentation |
| `headers` | No | Headers to auto-inject (`${VAR}` placeholders resolved from `secrets`) |
| `secrets` | No | Key-value pairs — literal strings or `${ENV_VAR}` references |
| `resolveSecretsInBody` | No | Resolve `${VAR}` in request bodies (default: `false`) |

Custom connectors with an `alias` matching a built-in connection name take precedence.

### Proxy Config (`proxy.config.json`)

Used by the local MCP proxy to connect to the remote server:

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "connectTimeout": 10000,
  "requestTimeout": 30000
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `remoteUrl` | URL of the remote server | `http://localhost:9999` |
| `connectTimeout` | Handshake timeout (ms) | `10000` |
| `requestTimeout` | Request timeout (ms) | `30000` |

Key paths are derived automatically — no configuration needed:
- Caller keys: `keys/callers/{MCP_KEY_ALIAS || "default"}/`
- Server public keys: `keys/server/`

### Advanced Configuration

#### `MCP_CONFIG_DIR`

By default, all config and key files live in `~/.drawlatch/`. Override with:

```bash
export MCP_CONFIG_DIR=/custom/path/to/config
```

Useful for CI environments or running multiple independent setups on the same machine.

## Connections

23 pre-built connection templates ship with drawlatch. Reference them by name in a caller's `connections` list:

| Connection | API | Required Env Var(s) |
|------------|-----|---------------------|
| `anthropic` | Anthropic Claude API | `ANTHROPIC_API_KEY` |
| `bluesky` | Bluesky (AT Protocol) | `BLUESKY_ACCESS_TOKEN` |
| `devin` | Devin AI API | `DEVIN_API_KEY` |
| `discord-bot` | Discord Bot API | `DISCORD_BOT_TOKEN` |
| `discord-oauth` | Discord OAuth2 API | `DISCORD_OAUTH_TOKEN` |
| `github` | GitHub REST API | `GITHUB_TOKEN` |
| `google` | Google Workspace APIs | `GOOGLE_API_TOKEN` |
| `google-ai` | Google AI (Gemini) | `GOOGLE_AI_API_KEY` |
| `hex` | Hex API | `HEX_TOKEN` |
| `lichess` | Lichess API | `LICHESS_API_TOKEN` |
| `linear` | Linear GraphQL API | `LINEAR_API_KEY` |
| `mastodon` | Mastodon API | `MASTODON_ACCESS_TOKEN` |
| `notion` | Notion API | `NOTION_API_KEY` |
| `openai` | OpenAI API | `OPENAI_API_KEY` |
| `openrouter` | OpenRouter API | `OPENROUTER_API_KEY` |
| `reddit` | Reddit API | `REDDIT_ACCESS_TOKEN` |
| `slack` | Slack Web API | `SLACK_BOT_TOKEN` |
| `stripe` | Stripe Payments API | `STRIPE_SECRET_KEY` |
| `telegram` | Telegram Bot API | `TELEGRAM_BOT_TOKEN` |
| `trello` | Trello API | `TRELLO_API_KEY`, `TRELLO_TOKEN` |
| `twitch` | Twitch Helix API | `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID` |
| `x` | X (Twitter) API v2 | `X_BEARER_TOKEN` |

See **[CONNECTIONS.md](CONNECTIONS.md)** for auth details, optional env vars, and usage notes per connection.

## Event Ingestion

Drawlatch can collect real-time events from external services and buffer them for agents to poll. Three ingestor types are supported:

| Type | How It Works | Connections |
|------|-------------|-------------|
| **WebSocket** | Persistent connections to event gateways | Discord Gateway, Slack Socket Mode |
| **Webhook** | HTTP receivers with signature verification | GitHub, Stripe, Trello |
| **Poll** | Interval-based HTTP requests | Notion, Linear, Reddit, X, Bluesky, Mastodon, Telegram, Twitch |

Events are stored in per-caller ring buffers (default 200, max 1000) with monotonic IDs for cursor-based pagination. Agents retrieve events via `poll_events` and check status via `ingestor_status`.

For webhook ingestors, the remote server must be publicly accessible (or behind a tunnel). Use `drawlatch start --tunnel` to automatically start a Cloudflare tunnel.

See **[INGESTORS.md](INGESTORS.md)** for full configuration reference.

## Key Exchange

Remote mode requires mutual authentication via Ed25519/X25519 keypairs. Each identity gets four PEM files (signing + exchange, public + private). The `drawlatch init` command handles this automatically for single-machine setups.

**Directory structure:**

```
~/.drawlatch/keys/
├── callers/
│   ├── default/           # Default caller keypair
│   └── alice/             # Additional caller keypair
└── server/                # Server keypair
```

Both sides (caller and server) store their keys in the same directory tree. On a single machine, `drawlatch init` generates both and they can authenticate immediately. On separate machines, copy the `*.pub.pem` files to the corresponding directory on the other machine.

**Using [Callboard](https://github.com/WolpertingerLabs/callboard)?** Use `drawlatch sync` to exchange keys automatically via a double-code approval flow — no manual file copying needed.

### Multiple Agent Identities

Generate a keypair per agent and set `MCP_KEY_ALIAS` at spawn time:

```bash
drawlatch generate-keys caller alice
drawlatch generate-keys caller bob
```

```json
{
  "mcpServers": {
    "drawlatch": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "env": { "MCP_CONFIG_DIR": "~/.drawlatch", "MCP_KEY_ALIAS": "alice" }
    }
  }
}
```

Register each agent as a separate caller in `remote.config.json`.

## CLI Reference

```
drawlatch [command] [options]

Commands:
  init               Set up drawlatch (keys, config, .env) in one step
  start              Start the remote server (background daemon)
  stop               Stop the remote server
  restart            Restart the remote server
  status             Show server status (PID, port, uptime, health, sessions, dashboard URL)
  logs               View server logs
  config             Show effective configuration and secret status
  doctor             Validate setup and diagnose issues
  set-password       Set/change the dashboard password (alias: change-password)
  generate-keys      Generate Ed25519 + X25519 keypairs
  sync               Exchange keys with a callboard instance

Options:
  -h, --help         Show help
  -v, --version      Show version

Init options:
  --connections <list>  Comma-separated connections to enable (e.g., github,slack)
  --alias <name>        Caller alias (default: "default")

Start options:
  -f, --foreground   Run in foreground
  -t, --tunnel       Start a Cloudflare tunnel for webhooks
  --port <number>    Override configured port
  --host <address>   Override configured host

Logs options:
  -n, --lines <num>  Number of lines (default: 50)
  --follow           Tail the log output

Generate-keys subcommands:
  caller [alias]     Generate caller keypair (default alias: "default")
  server             Generate server keypair
  show <path>        Show fingerprint of existing keypair
  --dir <path>       Generate to custom directory

Sync options:
  --ttl <seconds>    Session timeout (default: 300)
```

## Library Usage (Local Mode)

Import drawlatch directly for in-process use — no server, no encryption:

```typescript
import { loadRemoteConfig, resolveCallerRoutes, resolveRoutes, resolveSecrets } from "drawlatch/shared/config";
import { executeProxyRequest } from "drawlatch/remote/server";

const config = loadRemoteConfig();
const callerRoutes = resolveCallerRoutes(config, "my-laptop");
const callerEnv = resolveSecrets(config.callers["my-laptop"]?.env ?? {});
const routes = resolveRoutes(callerRoutes, callerEnv);

const result = await executeProxyRequest(
  { method: "GET", url: "https://api.github.com/user" },
  routes,
);
```

### Available Exports

| Export Path | Description |
|-------------|-------------|
| `drawlatch` | MCP proxy server (stdio transport) |
| `drawlatch/remote/server` | `executeProxyRequest()` and server functions |
| `drawlatch/remote/ingestors` | `IngestorManager` and ingestor types |
| `drawlatch/shared/config` | Config loading, route/secret resolution |
| `drawlatch/shared/connections` | Connection template loading |
| `drawlatch/shared/env-utils` | Environment variable and secret utilities |
| `drawlatch/shared/crypto` | Key generation, encrypted channel |
| `drawlatch/shared/protocol` | Handshake protocol, message types |

## Security Model

### Both Modes

- **Endpoint allowlisting** — requests only proxied to explicitly configured URL patterns
- **Per-caller access control** — each caller only sees their assigned connections
- **Per-caller credential isolation** — same connector, different credentials via `env` overrides
- **Rate limiting** — configurable per-session (default: 60/min)
- **Audit logging** — all operations logged with caller identity, session ID, timestamps

### Remote Mode Only

- **Zero secrets on the client** — the MCP proxy never sees API keys or tokens
- **Mutual authentication** — Ed25519 signatures before any data exchange
- **End-to-end encryption** — AES-256-GCM with X25519 ECDH session keys
- **Replay protection** — monotonic counters on all encrypted messages
- **Session isolation** — unique session keys per handshake, 30-minute TTL
- **File permissions** — private keys `0600`, key directories `0700`

## Development

```bash
npm test                  # Run tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
npm run lint              # Lint
npm run format            # Format

npm run dev:remote        # Remote server with hot reload
npm run dev:mcp           # MCP proxy with hot reload
```

### Source Structure

```
src/
├── cli/                     # Key generation CLI
├── connections/             # 23 pre-built route templates (JSON)
├── auth/                    # Dashboard auth (scrypt password, session cookies)
├── mcp/server.ts            # Local MCP proxy (stdio transport)
├── remote/
│   ├── server.ts            # Remote secure server (Express) — also serves the dashboard
│   ├── admin.ts             # Read-only /api/admin/* API
│   └── ingestors/           # Event ingestion system
│       ├── discord/         # Discord Gateway WebSocket
│       ├── slack/           # Slack Socket Mode WebSocket
│       ├── webhook/         # GitHub, Stripe, Trello webhooks
│       └── poll/            # Interval-based HTTP polling
└── shared/
    ├── config.ts            # Config loading, route resolution
    ├── connections.ts       # Connection template loading
    ├── env-utils.ts         # Environment variable utilities
    ├── crypto/              # Ed25519/X25519 keys, AES-256-GCM channel
    └── protocol/            # Handshake, message types

frontend/                    # React + Vite dashboard SPA (built to frontend/dist)
└── src/pages/               # Overview, Connections, Callers, Ingestors, Sessions, Secrets
```

## License

MIT
