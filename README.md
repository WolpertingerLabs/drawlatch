# Drawlatch

> **Alpha Software:** This project is in alpha. Expect breaking changes between updates.

A config-driven MCP (Model Context Protocol) proxy that lets Claude Code make authenticated HTTP requests to external APIs. Supports 22 pre-built API connections with endpoint allowlisting, per-caller access control, and real-time event ingestion — all configured through a single JSON file.

Drawlatch can run in two modes:

- **Remote mode** — local proxy + remote server, with end-to-end encryption. Secrets never leave the remote server.
- **Local mode** — imported as a library and called in-process (no server, no encryption). Secrets are on the same machine, but you get the same config-driven route resolution, endpoint allowlisting, and ingestor support.

## How It Works

### Remote Mode (Two-Component)

In remote mode, the system has two components:

1. **Local MCP Proxy** — runs on your machine as a Claude Code MCP server (stdio transport). It holds **no secrets**. It encrypts requests and forwards them to the remote server.
2. **Remote Secure Server** — holds all secrets (API keys, tokens, etc.) and only communicates through encrypted channels after mutual authentication. It injects secrets into outgoing HTTP requests on the proxy's behalf.

```
┌──────────────┐     Encrypted Channel     ┌──────────────────┐     Authenticated     ┌──────────────┐
│  Claude Code │ ◄──── stdio ────► MCP     │◄── HTTP + E2EE ──►│  Remote Server       │────  HTTPS ───►│  External API │
│              │                   Proxy    │                   │  (holds secrets)     │               │               │
└──────────────┘                            └──────────────────┘                       └──────────────┘
                    No secrets here                                Injects API keys,
                                                                  tokens, headers
```

The crypto layer uses **Ed25519** signatures for authentication and **X25519 ECDH** for key exchange, deriving **AES-256-GCM** session keys — all built on Node.js native `crypto` with zero external crypto dependencies.

### Local Mode (In-Process Library)

In local mode, there is no separate server, no network port, and no encryption. Your application imports Drawlatch's core functions directly and calls them in-process:

```
┌──────────────────────────────────────────┐     Authenticated     ┌──────────────┐
│  Your Application                        │────  HTTPS ───────────►│  External API │
│  ┌──────────┐   in-process   ┌────────┐ │                        │               │
│  │  Agent   │◄──  call  ────►│ drawl. │ │  Reads secrets from    └──────────────┘
│  │          │                │ routes │ │  local env / config
│  └──────────┘                └────────┘ │
└──────────────────────────────────────────┘
         Secrets are on the same machine
```

**What you get in local mode:** The same config-driven route resolution, endpoint allowlisting, per-caller access control, connection templates, ingestor support (WebSocket, webhook, polling), and the exact same `executeProxyRequest()` function the remote server uses — no behavioral drift.

**What you don't get:** Secret isolation from the agent. When running locally, secrets live in `process.env` on the same machine. The value proposition shifts from cryptographic secret hiding to **convenience and structured access** — a single config file managing many API connections with consistent patterns.

> **When to use which mode:** Use remote mode when you need to hide secrets from the machine running the agent (e.g., shared CI servers, untrusted environments). Use local mode when running on your own machine and you want the convenience of config-driven API management without the overhead of running a separate server.

## Quick Start

### Option 1: Install as a Claude Code Plugin (Recommended)

This repo is structured as a **Claude Code plugin** with a marketplace. Install it directly:

```shell
# Add the marketplace (from a local clone)
/plugin marketplace add ./path/to/drawlatch

# Install the plugin
/plugin install drawlatch@drawlatch
```

Or load it directly during development:

```shell
claude --plugin-dir ./path/to/drawlatch
```

Before using, set the `MCP_CONFIG_DIR` environment variable so the proxy can find its config and keys:

```bash
export MCP_CONFIG_DIR=~/.drawlatch
```

The plugin's MCP server starts automatically when enabled. The `secure_request` and `list_routes` tools become available immediately.

### Option 2: Auto-Discovery (opening this repo directly)

This repo includes a `.mcp.json` file at the root, so Claude Code **automatically discovers** the MCP proxy server when you open the project. On first launch, Claude Code will prompt you to approve the server — accept, and the `secure_request` and `list_routes` tools become available immediately.

Before approving, set the `MCP_CONFIG_DIR` environment variable:

```bash
export MCP_CONFIG_DIR=~/.drawlatch
```

The `.mcp.json` passes this through to the MCP server process. You also need a working setup (keys generated, public keys exchanged, configs in place, remote server running). See [Setup](#setup) below for the full walkthrough.

> **Note:** Auto-discovery uses the `dist/mcp/server.js` entrypoint. The `dist/` directory is built automatically when you run `npm install` (via the `prepare` script). If you need to rebuild manually, run `npm run build`.

## Setup

### Prerequisites

```bash
git clone <repo-url>
cd drawlatch
npm install
npm run build
```

### Directory Structure

All config and key files live inside `~/.drawlatch/` in the user's home directory by default. You can override this by setting the `MCP_CONFIG_DIR` environment variable.

```
~/.drawlatch/
├── proxy.config.json                          # Local proxy config
├── remote.config.json                         # Remote server config
└── keys/
    ├── local/                                 # MCP proxy keypairs (one per alias)
    │   └── my-laptop/                         # Alias-named subdirectory
    │       ├── signing.pub.pem                # Ed25519 public key (share this)
    │       ├── signing.key.pem                # Ed25519 private key (keep secret)
    │       ├── exchange.pub.pem               # X25519 public key (share this)
    │       └── exchange.key.pem               # X25519 private key (keep secret)
    ├── remote/                                # Remote server keypair
    │   ├── signing.pub.pem
    │   ├── signing.key.pem
    │   ├── exchange.pub.pem
    │   └── exchange.key.pem
    └── peers/
        ├── alice/                             # One subdirectory per caller
        │   ├── signing.pub.pem               # Caller's public signing key
        │   └── exchange.pub.pem              # Caller's public exchange key
        ├── bob/                               # Another caller
        │   ├── signing.pub.pem
        │   └── exchange.pub.pem
        └── remote-server/                     # Remote server's public keys (for proxy)
            ├── signing.pub.pem
            └── exchange.pub.pem
```

### Step 1: Generate Keys

Generate keypairs for both the local proxy and the remote server:

```bash
# Generate local MCP proxy keypair (with alias)
npm run generate-keys -- local my-laptop

# Or use the default alias
npm run generate-keys -- local

# Generate remote server keypair
npm run generate-keys -- remote
```

Each command creates four PEM files (Ed25519 signing + X25519 exchange, public + private) in the appropriate directory under `~/.drawlatch/keys/`. Local keys are stored under `keys/local/<alias>/` — the alias defaults to `"default"` if omitted.

> **Multiple identities:** Generate multiple local keypairs using different aliases (e.g., `my-laptop`, `ci-server`). Set `MCP_KEY_ALIAS` per agent at spawn time or use `localKeyAlias` in `proxy.config.json` to select which identity the proxy uses. The alias directory name should match the caller alias in the remote server's config.

You can also generate keys to a custom directory:

```bash
npm run generate-keys -- --dir /path/to/custom/keys
```

Or inspect the fingerprint of an existing keypair:

```bash
npm run generate-keys -- show ~/.drawlatch/keys/local/my-laptop
```

### Step 2: Exchange Public Keys

The local proxy and remote server need each other's public keys for mutual authentication. Copy the **public** key files (`.pub.pem` only — never share private keys):

**From local to remote** — copy the proxy's public keys into a caller directory on the remote server. Since local keys are now stored per-alias, the alias directory name naturally matches the peer directory:

```bash
mkdir -p ~/.drawlatch/keys/peers/my-laptop

cp ~/.drawlatch/keys/local/my-laptop/signing.pub.pem \
   ~/.drawlatch/keys/peers/my-laptop/signing.pub.pem

cp ~/.drawlatch/keys/local/my-laptop/exchange.pub.pem \
   ~/.drawlatch/keys/peers/my-laptop/exchange.pub.pem
```

**From remote to local** — copy the remote server's public keys into the proxy's peer directory:

```bash
mkdir -p ~/.drawlatch/keys/peers/remote-server

cp ~/.drawlatch/keys/remote/signing.pub.pem \
   ~/.drawlatch/keys/peers/remote-server/signing.pub.pem

cp ~/.drawlatch/keys/remote/exchange.pub.pem \
   ~/.drawlatch/keys/peers/remote-server/exchange.pub.pem
```

> **Tip:** If the proxy and remote server are on different machines, securely transfer only the `*.pub.pem` files (e.g., via `scp`). Each caller gets its own subdirectory under the peers directory — the directory name becomes the caller's alias used in the remote config and audit logs.

### Step 3: Create the Local Proxy Config

Copy the example and edit the paths to match your setup:

```bash
cp proxy.config.example.json ~/.drawlatch/proxy.config.json
```

Edit `~/.drawlatch/proxy.config.json`:

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "localKeyAlias": "my-laptop",
  "remotePublicKeysDir": "~/.drawlatch/keys/peers/remote-server",
  "connectTimeout": 10000,
  "requestTimeout": 30000
}
```

| Field                 | Description                                                                                     | Default                               |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `remoteUrl`           | URL of the remote secure server                                                                 | `http://localhost:9999`               |
| `localKeyAlias`       | Key alias — resolved to `keys/local/<alias>/`. Overridden by `MCP_KEY_ALIAS` env var at runtime | _(none)_                              |
| `localKeysDir`        | Absolute path to the proxy's own keypair directory. Ignored when `localKeyAlias` is set         | `~/.drawlatch/keys/local/default`       |
| `remotePublicKeysDir` | Absolute path to the remote server's public keys                                                | `~/.drawlatch/keys/peers/remote-server` |
| `connectTimeout`      | Handshake timeout in milliseconds                                                               | `10000` (10s)                         |
| `requestTimeout`      | Request timeout in milliseconds                                                                 | `30000` (30s)                         |

**Alias resolution priority:**

1. `MCP_KEY_ALIAS` env var (highest — set per agent at spawn time)
2. `localKeyAlias` in `proxy.config.json`
3. `localKeysDir` in `proxy.config.json` (explicit full path for custom deployments)
4. Default: `keys/local/default`

### Step 4: Create the Remote Server Config

Copy the example and edit it to match your setup:

```bash
cp remote.config.example.json ~/.drawlatch/remote.config.json
```

Edit `~/.drawlatch/remote.config.json`. This is where you define your callers, their connections, custom connectors, and secrets.

The config is **caller-centric** — each caller is identified by their public key and explicitly declares which connections they can access.

#### Example: Single caller with a built-in connection

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "~/.drawlatch/keys/remote",
  "callers": {
    "my-laptop": {
      "name": "Personal Laptop",
      "peerKeyDir": "~/.drawlatch/keys/peers/my-laptop",
      "connections": ["github"]
    }
  },
  "rateLimitPerMinute": 60
}
```

Set the `GITHUB_TOKEN` environment variable on the remote server and the built-in `github` connection template handles everything else — endpoint patterns, auth headers, docs URLs, and OpenAPI specs.

#### Example: Multiple callers with different access levels

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "~/.drawlatch/keys/remote",
  "connectors": [
    {
      "alias": "internal-api",
      "name": "Internal Admin API",
      "headers": { "Authorization": "Bearer ${ADMIN_KEY}" },
      "secrets": { "ADMIN_KEY": "${INTERNAL_ADMIN_KEY}" },
      "allowedEndpoints": ["https://admin.internal.com/**"]
    }
  ],
  "callers": {
    "alice": {
      "name": "Alice (senior engineer)",
      "peerKeyDir": "/keys/peers/alice",
      "connections": ["github", "stripe", "internal-api"]
    },
    "ci-server": {
      "name": "GitHub Actions CI",
      "peerKeyDir": "/keys/peers/ci-server",
      "connections": ["github"]
    }
  },
  "rateLimitPerMinute": 60
}
```

Alice gets access to GitHub, Stripe, and the internal API. The CI server only gets GitHub. Each caller is isolated — they only see the routes for their declared connections.

#### Example: Per-caller env overrides (shared connector, different credentials)

When multiple callers use the same connection but need different credentials, use the `env` field to redirect environment variable resolution per caller:

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/keys/server",
  "callers": {
    "alice": {
      "name": "Alice",
      "peerKeyDir": "/keys/peers/alice",
      "connections": ["github"],
      "env": {
        "GITHUB_TOKEN": "${ALICE_GITHUB_TOKEN}"
      }
    },
    "bob": {
      "name": "Bob",
      "peerKeyDir": "/keys/peers/bob",
      "connections": ["github", "stripe"],
      "env": {
        "GITHUB_TOKEN": "${BOB_GITHUB_TOKEN}",
        "STRIPE_SECRET_KEY": "sk_test_bob_dev_key"
      }
    }
  },
  "rateLimitPerMinute": 60
}
```

The `env` map works as follows:

- **Keys** are the env var names that connectors reference (e.g., `GITHUB_TOKEN`)
- **Values** are either `"${REAL_ENV_VAR}"` (redirect to a different env var) or a literal string (direct injection)
- When resolving secrets, the caller's `env` is checked **before** `process.env`

In this example, both Alice and Bob use the same built-in `github` connection, but Alice's requests use `process.env.ALICE_GITHUB_TOKEN` while Bob's use `process.env.BOB_GITHUB_TOKEN`. Bob also gets a hardcoded Stripe test key without needing an env var.

#### Remote Config Reference

| Field                | Description                                                                                                                                  | Default                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `host`               | Network interface to bind to. Use `0.0.0.0` for all interfaces or `127.0.0.1` for local only                                                 | `127.0.0.1`              |
| `port`               | Port to listen on                                                                                                                            | `9999`                   |
| `localKeysDir`       | Absolute path to the remote server's own keypair                                                                                             | `~/.drawlatch/keys/remote` |
| `connectors`         | Array of custom connector definitions, each with an `alias` for referencing from callers (see [Connector Definition](#connector-definition)) | `[]`                     |
| `callers`            | Per-caller access control. Keys are caller aliases used in audit logs (see [Caller Definition](#caller-definition))                          | `{}`                     |
| `rateLimitPerMinute` | Max requests per minute per session                                                                                                          | `60`                     |

#### Connector Definition

Custom connectors define reusable route templates referenced by `alias` from caller connection lists. They follow the same structure as routes:

| Field                  | Required | Description                                                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `alias`                | Yes      | Unique name for referencing this connector from caller `connections` lists                                               |
| `allowedEndpoints`     | Yes      | Array of glob patterns for allowed URLs (e.g., `https://api.example.com/**`)                                             |
| `name`                 | No       | Human-readable name (e.g., `"Internal Admin API"`)                                                                       |
| `description`          | No       | Short description of what the connector provides                                                                         |
| `docsUrl`              | No       | URL to API documentation                                                                                                 |
| `openApiUrl`           | No       | URL to OpenAPI/Swagger spec                                                                                              |
| `headers`              | No       | Headers to auto-inject. Values may contain `${VAR}` placeholders resolved from `secrets`                                 |
| `secrets`              | No       | Key-value pairs. Values can be literal strings or `${ENV_VAR}` references resolved from environment variables at startup |
| `resolveSecretsInBody` | No       | Whether to resolve `${VAR}` placeholders in request bodies. Default: `false`                                             |

#### Caller Definition

| Field               | Required | Description                                                                                                                                       |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peerKeyDir`        | Yes      | Path to this caller's public key files (`signing.pub.pem` + `exchange.pub.pem`)                                                                   |
| `connections`       | Yes      | Array of connection names — references built-in templates (e.g., `"github"`) or custom connector aliases                                          |
| `name`              | No       | Human-readable name for audit logs                                                                                                                |
| `env`               | No       | Per-caller environment variable overrides (see [env overrides example](#example-per-caller-env-overrides-shared-connector-different-credentials)) |
| `ingestorOverrides` | No       | Per-caller ingestor config overrides keyed by connection alias. Override event filters, buffer sizes, intents, or disable ingestors entirely. See **[INGESTORS.md](INGESTORS.md#caller-level-ingestor-overrides)** for full reference |

#### How Secrets Work

Secret values in the `secrets` map are resolved at session establishment time (per-caller):

- **Literal values** — used as-is: `"API_TOKEN": "sk_live_abc123"`
- **Environment variable references** — resolved from the server's environment: `"API_TOKEN": "${API_TOKEN}"`
- **Per-caller overrides** — when a caller has an `env` entry for a variable name, that value is used instead of `process.env`

Header values can reference secrets using `${VAR}` placeholders:

```json
"headers": {
  "Authorization": "Bearer ${API_TOKEN}"
}
```

The placeholder `${API_TOKEN}` is resolved against the route's resolved `secrets` map. This means the actual secret value is never exposed to the local proxy or Claude Code — it only exists on the remote server.

### Connections (Pre-built Route Templates)

Instead of manually configuring connectors for popular APIs, you can use **connections** — pre-built route templates that ship with the package (`github`, `stripe`, `openai`, etc.). Reference them by name in a caller's `connections` list:

```json
{
  "callers": {
    "my-laptop": {
      "peerKeyDir": "/keys/peers/my-laptop",
      "connections": ["github", "stripe"]
    }
  }
}
```

Set the required environment variables (e.g., `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`) and the connection templates handle endpoint patterns, auth headers, docs URLs, and OpenAPI specs automatically. Custom connectors with a matching `alias` take precedence over built-in templates.

See **[CONNECTIONS.md](CONNECTIONS.md)** for the full list of available connections, required environment variables, and usage examples.

### Step 5: Start the Servers

**Start the remote server:**

```bash
# Development (with hot reload via tsx)
npm run dev:remote

# Production (requires `npm run build` first)
npm run start:remote
```

**Connect the local MCP proxy to Claude Code:**

The repo includes a `.mcp.json` at the root, so Claude Code auto-discovers the proxy when you open the project directory. Just approve the server when prompted — no manual registration needed.

The `.mcp.json` requires the `MCP_CONFIG_DIR` environment variable to be set so the proxy can locate its config and keys. Set it to the absolute path of your `~/.drawlatch/` directory:

```bash
export MCP_CONFIG_DIR=~/.drawlatch
```

**Alternative: manual registration**

If you prefer not to use auto-discovery, register the MCP server directly:

```bash
claude mcp add secure-proxy \
  --transport stdio --scope local \
  -e MCP_CONFIG_DIR=~/.drawlatch \
  -- node /absolute/path/to/drawlatch/dist/mcp/server.js
```

After connecting (either via auto-discovery or manual registration), the proxy will automatically perform the encrypted handshake with the remote server on first use.

### Step 6: Webhook Endpoints (Optional)

If any of your connections use webhook ingestors (e.g., GitHub, Stripe, Trello), the remote server automatically exposes `POST /webhooks/:path` routes on the same port. External services send webhook POSTs to these endpoints, and the server verifies signatures, buffers events in per-caller ring buffers, and makes them available via `poll_events`.

**Setup:**

1. The remote server must be **publicly accessible** for webhook delivery (or behind a tunnel like [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/))
2. Point the external service's webhook URL to `https://<your-server>/webhooks/<path>` (e.g., `https://example.com/webhooks/github`)
3. Set the webhook signing secret as an environment variable on the remote server (e.g., `GITHUB_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`)

The webhook path is configured in each connection template's `ingestor.webhook.path` field. See **[INGESTORS.md](INGESTORS.md)** for full details on webhook, WebSocket, and poll ingestors.

### Multiple Agents (Multi-Identity)

When multiple agents share the same machine, each needs its own key identity. Generate a keypair per agent:

```bash
npm run generate-keys -- local alice
npm run generate-keys -- local bob
```

Each agent's MCP server config specifies its alias via the `MCP_KEY_ALIAS` env var:

```json
{
  "mcpServers": {
    "secure-proxy": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "env": {
        "MCP_CONFIG_DIR": "~/.drawlatch",
        "MCP_KEY_ALIAS": "alice"
      }
    }
  }
}
```

The proxy auto-resolves `MCP_KEY_ALIAS=alice` to `keys/local/alice/`. On the remote server, register each agent as a separate caller with matching alias directories under `keys/peers/`.

## MCP Tools

Once connected, Claude Code gets access to four tools:

### `secure_request`

Make an authenticated HTTP request through the proxy. Route-level headers (e.g., `Authorization`) are injected automatically — the agent never sees the secret values.

```
method: GET | POST | PUT | PATCH | DELETE
url: Full URL (may contain ${VAR} placeholders)
headers: Optional additional headers
body: Optional request body
```

### `list_routes`

List all available routes for the current caller. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names. Different callers may see different routes based on their `connections` configuration.

### `poll_events`

Poll for new events from ingestors (Discord messages, GitHub webhooks, Notion updates, etc.). Returns events received since the given cursor.

```
connection: Optional — filter by connection alias (e.g., "discord-bot"), omit for all
after_id: Optional — cursor; returns events with id > after_id
```

Pass `after_id` from the last event you received to get only new events. Omit to get all buffered events. See **[INGESTORS.md](INGESTORS.md)** for details on configuring event sources.

### `ingestor_status`

Get the status of all active ingestors for the current caller. Returns connection state, buffer sizes, event counts, and any errors. Takes no parameters.

## Library Usage (Local Mode)

Drawlatch can be imported as a library for in-process use — no separate server, no encryption overhead. The `package.json` exports map provides clean entry points:

```typescript
// Core request execution (same function the remote server uses)
import { executeProxyRequest } from "drawlatch/remote/server";

// Config loading and route resolution
import {
  loadRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
} from "drawlatch/shared/config";

// Ingestor management (WebSocket, webhook, poll)
import { IngestorManager } from "drawlatch/remote/ingestors";

// Crypto primitives (if building custom transport)
import { loadKeyBundle, loadPublicKeys, EncryptedChannel } from "drawlatch/shared/crypto";
```

### Available Exports

| Export Path                  | Description                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `drawlatch`                  | MCP proxy server (stdio transport) — the default entry point       |
| `drawlatch/remote/server`    | Remote server functions including `executeProxyRequest()`          |
| `drawlatch/remote/ingestors` | `IngestorManager` and all ingestor types                           |
| `drawlatch/shared/config`    | Config loading, caller/route resolution, secret resolution         |
| `drawlatch/shared/connections`| Connection template loading                                       |
| `drawlatch/shared/crypto`    | Key generation, encrypted channel, key serialization               |
| `drawlatch/shared/protocol`  | Handshake protocol, message types                                  |

### Example: In-Process Proxy

```typescript
import { loadRemoteConfig, resolveCallerRoutes, resolveRoutes, resolveSecrets } from "drawlatch/shared/config";
import { executeProxyRequest } from "drawlatch/remote/server";

// Load config and resolve routes for a specific caller
const config = loadRemoteConfig();
const callerRoutes = resolveCallerRoutes(config, "my-laptop");
const callerEnv = resolveSecrets(config.callers["my-laptop"]?.env ?? {});
const routes = resolveRoutes(callerRoutes, callerEnv);

// Make a request — same function the remote server uses
const result = await executeProxyRequest(
  { method: "GET", url: "https://api.github.com/user" },
  routes,
);
```

> **Note:** In local mode, secrets are resolved from `process.env` on the same machine. The encryption layer is not used. See [How It Works → Local Mode](#local-mode-in-process-library) for the security tradeoff.

## Development

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint
npm run lint:fix

# Format
npm run format
npm run format:check
```

## Architecture

### Plugin Structure

This repo is structured as a Claude Code plugin:

```
drawlatch/
├── .claude-plugin/              # Plugin metadata
│   ├── plugin.json              # Plugin manifest (name, version, description)
│   └── marketplace.json         # Marketplace catalog for distribution
├── .mcp.json                    # MCP server config (used by plugin system + auto-discovery)
├── dist/                        # Compiled JavaScript (built via `npm run build` or `prepare`)
│   └── mcp/server.js            # MCP proxy entrypoint
└── src/                         # TypeScript source
```

### Source Code

```
src/
├── cli/                        # Key generation CLI
│   └── generate-keys.ts        # Ed25519 + X25519 keypair generation
├── connections/                 # Pre-built route templates (JSON)
│   ├── github.json             # GitHub REST API
│   ├── stripe.json             # Stripe Payments API
│   └── ...                     # 22 templates total
├── mcp/
│   └── server.ts               # Local MCP proxy server (stdio transport)
├── remote/
│   ├── server.ts               # Remote secure server (Express HTTP)
│   ├── server.test.ts          # Unit tests
│   ├── server.e2e.test.ts      # End-to-end tests
│   └── ingestors/              # Real-time event ingestion system
│       ├── base-ingestor.ts    # Abstract base class (state machine, ring buffer)
│       ├── ring-buffer.ts      # Generic bounded circular buffer
│       ├── manager.ts          # Lifecycle management, per-caller routing
│       ├── registry.ts         # Factory registry for ingestor types
│       ├── types.ts            # Shared types and config interfaces
│       ├── discord/            # Discord Gateway WebSocket (v10)
│       ├── slack/              # Slack Socket Mode WebSocket
│       ├── webhook/            # Webhook receivers (GitHub, Stripe, Trello)
│       └── poll/               # Interval-based HTTP polling (Notion, Linear, etc.)
└── shared/
    ├── config.ts               # Config loading/saving, caller & route resolution
    ├── connections.ts           # Connection template loading
    ├── logger.ts               # Structured logging
    ├── crypto/
    │   ├── keys.ts             # Ed25519 + X25519 key generation/serialization
    │   ├── channel.ts          # AES-256-GCM encrypted channel
    │   └── index.ts            # Re-exports
    └── protocol/
        ├── handshake.ts        # Mutual auth (Noise NK-inspired)
        ├── messages.ts         # Application-layer message types
        └── index.ts            # Re-exports
```

## Security Model

### Both Modes

These protections apply regardless of whether you use remote or local mode:

- **Per-caller access control** — each caller only sees and can use the connections explicitly assigned to them
- **Per-caller credential isolation** — callers sharing the same connector can have different credentials via `env` overrides
- **Endpoint allowlisting** — requests are only proxied to explicitly configured URL patterns
- **Rate limiting** — configurable per-session request rate limiting (default: 60/min)
- **Audit logging** — all operations are logged with caller identity, session ID, and timestamps

### Remote Mode Only

These additional protections apply when running the two-component remote architecture:

- **Zero secrets on the client** — the local MCP proxy never sees API keys or tokens
- **Mutual authentication** — both sides prove their identity using Ed25519 signatures before any data is exchanged
- **End-to-end encryption** — all requests/responses are encrypted with AES-256-GCM session keys derived via X25519 ECDH
- **Replay protection** — monotonic counters prevent replay attacks
- **Session isolation** — each handshake produces unique session keys with a 30-minute TTL
- **File permissions** — private keys are saved with `0600`, directories with `0700`

### Local Mode Caveat

When using Drawlatch as an in-process library (local mode), secrets are resolved from `process.env` on the same machine as the agent. The encryption and mutual authentication layers are not used. The security value in local mode comes from **structured access control** (endpoint allowlisting, per-caller route isolation) rather than cryptographic secret isolation.

## License

MIT
