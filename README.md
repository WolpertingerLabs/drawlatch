# Drawlatch

> **Alpha Software:** Expect breaking changes between updates.

Drawlatch is a config-driven proxy that gives AI agents authenticated access to external APIs. Define your connections and secrets in a single config file — agents get structured, allowlisted access to 22 pre-built APIs without ever seeing your credentials.

**Using [Callboard](https://github.com/WolpertingerLabs/callboard)?** Drawlatch is built in — Callboard manages connections, secrets, and agent identities through its UI. You don't need to set up drawlatch separately.

## Key Features

- **22 pre-built connections** — GitHub, Slack, Discord, Stripe, Notion, Linear, OpenAI, and [more](CONNECTIONS.md)
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

### Install

```bash
npm install -g @wolpertingerlabs/drawlatch
```

Or clone and build from source:

```bash
git clone https://github.com/WolpertingerLabs/drawlatch.git
cd drawlatch
npm install
```

### Configure

All config lives in `~/.drawlatch/` by default (override with `MCP_CONFIG_DIR`).

**1. Create the remote server config:**

```bash
cp remote.config.example.json ~/.drawlatch/remote.config.json
```

At minimum, define your callers and their connections:

```json
{
  "port": 9999,
  "callers": {
    "my-laptop": {
      "peerKeyDir": "~/.drawlatch/keys/peers/my-laptop",
      "connections": ["github", "slack"]
    }
  }
}
```

**2. Set your API secrets** in the environment (via `.env`, shell export, or your deployment platform):

```bash
GITHUB_TOKEN=ghp_your_token_here
SLACK_BOT_TOKEN=xoxb-your-token-here
```

**3. Generate keys** (remote mode only):

```bash
drawlatch generate-keys local my-laptop
drawlatch generate-keys remote
```

Then exchange public keys between the proxy and server — copy `*.pub.pem` files into the appropriate `keys/peers/` subdirectories. See [Key Exchange](#key-exchange) for details.

### Run

**Start the remote server:**

```bash
drawlatch start                    # background daemon
drawlatch start -f                 # foreground
drawlatch start --tunnel           # with Cloudflare tunnel for webhooks
```

**Connect the MCP proxy to Claude Code:**

The repo includes `.mcp.json` for auto-discovery. Or register manually:

```bash
claude mcp add drawlatch \
  -e MCP_CONFIG_DIR=~/.drawlatch \
  -- node /path/to/drawlatch/dist/mcp/server.js
```

You can also install drawlatch as a Claude Code plugin:

```bash
claude plugin install drawlatch
```

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
  "localKeysDir": "~/.drawlatch/keys/remote",
  "connectors": [],
  "callers": {},
  "rateLimitPerMinute": 60
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `host` | Network interface to bind | `127.0.0.1` |
| `port` | Listen port | `9999` |
| `localKeysDir` | Path to server's own keypair | `~/.drawlatch/keys/remote` |
| `connectors` | Custom connector definitions (see below) | `[]` |
| `callers` | Per-caller access control (see below) | `{}` |
| `rateLimitPerMinute` | Max requests per minute per session | `60` |

### Callers

Each caller is identified by their public key and declares which connections they can access:

```json
{
  "callers": {
    "alice": {
      "name": "Alice (senior engineer)",
      "peerKeyDir": "~/.drawlatch/keys/peers/alice",
      "connections": ["github", "stripe", "internal-api"],
      "env": {
        "GITHUB_TOKEN": "${ALICE_GITHUB_TOKEN}"
      }
    },
    "ci-server": {
      "name": "GitHub Actions CI",
      "peerKeyDir": "~/.drawlatch/keys/peers/ci-server",
      "connections": ["github"]
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `peerKeyDir` | Yes | Path to this caller's public key files |
| `connections` | Yes | Array of connection names (built-in or custom connector aliases) |
| `name` | No | Human-readable name for audit logs |
| `env` | No | Per-caller env var overrides — redirect secret resolution per caller |
| `ingestorOverrides` | No | Per-caller ingestor config overrides ([details](INGESTORS.md#caller-level-ingestor-overrides)) |

The `env` map lets multiple callers share the same connection with different credentials:
- Keys are the env var names connectors reference (e.g., `GITHUB_TOKEN`)
- Values are `"${REAL_ENV_VAR}"` (redirect) or literal strings (direct injection)
- Checked before `process.env` during secret resolution

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
  "localKeyAlias": "my-laptop",
  "remotePublicKeysDir": "~/.drawlatch/keys/peers/remote-server",
  "connectTimeout": 10000,
  "requestTimeout": 30000
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `remoteUrl` | URL of the remote server | `http://localhost:9999` |
| `localKeyAlias` | Key alias — resolved to `keys/local/<alias>/` | _(none)_ |
| `localKeysDir` | Explicit path to proxy's keypair (ignored when `localKeyAlias` is set) | `~/.drawlatch/keys/local/default` |
| `remotePublicKeysDir` | Path to remote server's public keys | `~/.drawlatch/keys/peers/remote-server` |
| `connectTimeout` | Handshake timeout (ms) | `10000` |
| `requestTimeout` | Request timeout (ms) | `30000` |

Key alias resolution order: `MCP_KEY_ALIAS` env var > `localKeyAlias` > `localKeysDir` > `keys/local/default`.

## Connections

22 pre-built connection templates ship with drawlatch. Reference them by name in a caller's `connections` list:

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

Remote mode requires mutual authentication via Ed25519/X25519 keypairs. Each identity gets four PEM files (signing + exchange, public + private).

**Directory structure:**

```
~/.drawlatch/keys/
├── local/my-laptop/       # MCP proxy keypair
├── remote/                # Remote server keypair
└── peers/
    ├── my-laptop/         # Proxy's public keys (on the server)
    └── remote-server/     # Server's public keys (on the proxy)
```

**Exchange public keys** (`.pub.pem` only — never share private keys):

```bash
# Proxy's public keys → server's peers directory
cp keys/local/my-laptop/signing.pub.pem   keys/peers/my-laptop/signing.pub.pem
cp keys/local/my-laptop/exchange.pub.pem  keys/peers/my-laptop/exchange.pub.pem

# Server's public keys → proxy's peers directory
cp keys/remote/signing.pub.pem   keys/peers/remote-server/signing.pub.pem
cp keys/remote/exchange.pub.pem  keys/peers/remote-server/exchange.pub.pem
```

If the proxy and server are on different machines, transfer only `*.pub.pem` files via `scp` or similar.

### Multiple Agent Identities

Generate a keypair per agent and set `MCP_KEY_ALIAS` at spawn time:

```bash
drawlatch generate-keys local alice
drawlatch generate-keys local bob
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

Register each agent as a separate caller on the remote server with matching peer key directories.

## CLI Reference

```
drawlatch [command] [options]

Commands:
  start              Start the remote server (background daemon)
  stop               Stop the remote server
  restart            Restart the remote server
  status             Show server status (PID, port, uptime, health, sessions)
  logs               View server logs
  config             Show effective configuration
  generate-keys      Generate Ed25519 + X25519 keypairs

Options:
  -h, --help         Show help
  -v, --version      Show version

Start options:
  -f, --foreground   Run in foreground
  -t, --tunnel       Start a Cloudflare tunnel for webhooks
  --port <number>    Override configured port
  --host <address>   Override configured host

Logs options:
  -n, --lines <num>  Number of lines (default: 50)
  --follow           Tail the log output

Generate-keys subcommands:
  local [alias]      Generate local proxy keypair (default alias: "default")
  remote             Generate remote server keypair
  show <path>        Show fingerprint of existing keypair
  --dir <path>       Generate to custom directory
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
├── connections/             # 22 pre-built route templates (JSON)
├── mcp/server.ts            # Local MCP proxy (stdio transport)
├── remote/
│   ├── server.ts            # Remote secure server (Express)
│   └── ingestors/           # Event ingestion system
│       ├── discord/         # Discord Gateway WebSocket
│       ├── slack/           # Slack Socket Mode WebSocket
│       ├── webhook/         # GitHub, Stripe, Trello webhooks
│       └── poll/            # Interval-based HTTP polling
└── shared/
    ├── config.ts            # Config loading, route resolution
    ├── connections.ts       # Connection template loading
    ├── crypto/              # Ed25519/X25519 keys, AES-256-GCM channel
    └── protocol/            # Handshake, message types
```

## License

MIT
