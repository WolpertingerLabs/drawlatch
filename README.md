# mcp-secure-proxy

An encrypted MCP (Model Context Protocol) proxy that lets Claude Code make authenticated HTTP requests through a secure, end-to-end encrypted channel. Your API keys and secrets never leave the remote server.

## How It Works

The system has two components:

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

## Quick Start

### Option 1: Install as a Claude Code Plugin (Recommended)

This repo is structured as a **Claude Code plugin** with a marketplace. Install it directly:

```shell
# Add the marketplace (from a local clone)
/plugin marketplace add ./path/to/mcp-secure-proxy

# Install the plugin
/plugin install mcp-secure-proxy@mcp-secure-proxy
```

Or load it directly during development:

```shell
claude --plugin-dir ./path/to/mcp-secure-proxy
```

Before using, set the `MCP_CONFIG_DIR` environment variable so the proxy can find its config and keys:

```bash
export MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy
```

The plugin's MCP server starts automatically when enabled. The `secure_request` and `list_routes` tools become available immediately.

### Option 2: Auto-Discovery (opening this repo directly)

This repo includes a `.mcp.json` file at the root, so Claude Code **automatically discovers** the MCP proxy server when you open the project. On first launch, Claude Code will prompt you to approve the server — accept, and the `secure_request` and `list_routes` tools become available immediately.

Before approving, set the `MCP_CONFIG_DIR` environment variable:

```bash
export MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy
```

The `.mcp.json` passes this through to the MCP server process. You also need a working setup (keys generated, public keys exchanged, configs in place, remote server running). See [Setup](#setup) below for the full walkthrough.

> **Note:** Auto-discovery uses the `dist/mcp/server.js` entrypoint. The `dist/` directory is built automatically when you run `npm install` (via the `postinstall` script). If you need to rebuild manually, run `npm run build`.

## Setup

### Prerequisites

```bash
git clone <repo-url>
cd mcp-secure-proxy
npm install
npm run build
```

### Directory Structure

All config and key files live inside a `.mcp-secure-proxy/` directory (relative to the project root by default). You can override this by setting the `MCP_CONFIG_DIR` environment variable.

```
.mcp-secure-proxy/
├── proxy.config.json                          # Local proxy config
├── remote.config.json                         # Remote server config
└── keys/
    ├── local/                                 # MCP proxy keypair
    │   ├── signing.pub.pem                    # Ed25519 public key (share this)
    │   ├── signing.key.pem                    # Ed25519 private key (keep secret)
    │   ├── exchange.pub.pem                   # X25519 public key (share this)
    │   └── exchange.key.pem                   # X25519 private key (keep secret)
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
# Generate local MCP proxy keypair
npm run generate-keys -- local

# Generate remote server keypair
npm run generate-keys -- remote
```

Each command creates four PEM files (Ed25519 signing + X25519 exchange, public + private) in the appropriate directory under `.mcp-secure-proxy/keys/`.

You can also generate keys to a custom directory:

```bash
npm run generate-keys -- --dir /path/to/custom/keys
```

Or inspect the fingerprint of an existing keypair:

```bash
npm run generate-keys -- show .mcp-secure-proxy/keys/local
```

### Step 2: Exchange Public Keys

The local proxy and remote server need each other's public keys for mutual authentication. Copy the **public** key files (`.pub.pem` only — never share private keys):

**From local to remote** — copy the proxy's public keys into a caller directory on the remote server:

```bash
mkdir -p .mcp-secure-proxy/keys/peers/my-laptop

cp .mcp-secure-proxy/keys/local/signing.pub.pem \
   .mcp-secure-proxy/keys/peers/my-laptop/signing.pub.pem

cp .mcp-secure-proxy/keys/local/exchange.pub.pem \
   .mcp-secure-proxy/keys/peers/my-laptop/exchange.pub.pem
```

**From remote to local** — copy the remote server's public keys into the proxy's peer directory:

```bash
mkdir -p .mcp-secure-proxy/keys/peers/remote-server

cp .mcp-secure-proxy/keys/remote/signing.pub.pem \
   .mcp-secure-proxy/keys/peers/remote-server/signing.pub.pem

cp .mcp-secure-proxy/keys/remote/exchange.pub.pem \
   .mcp-secure-proxy/keys/peers/remote-server/exchange.pub.pem
```

> **Tip:** If the proxy and remote server are on different machines, securely transfer only the `*.pub.pem` files (e.g., via `scp`). Each caller gets its own subdirectory under the peers directory — the directory name becomes the caller's alias used in the remote config and audit logs.

### Step 3: Create the Local Proxy Config

Copy the example and edit the paths to match your setup:

```bash
cp proxy.config.example.json .mcp-secure-proxy/proxy.config.json
```

Edit `.mcp-secure-proxy/proxy.config.json`:

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "localKeysDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/local",
  "remotePublicKeysDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/peers/remote-server",
  "connectTimeout": 10000,
  "requestTimeout": 30000
}
```

| Field                 | Description                                        | Default                                      |
| --------------------- | -------------------------------------------------- | -------------------------------------------- |
| `remoteUrl`           | URL of the remote secure server                    | `http://localhost:9999`                      |
| `localKeysDir`        | Absolute path to the proxy's own keypair directory | `.mcp-secure-proxy/keys/local`               |
| `remotePublicKeysDir` | Absolute path to the remote server's public keys   | `.mcp-secure-proxy/keys/peers/remote-server` |
| `connectTimeout`      | Handshake timeout in milliseconds                  | `10000` (10s)                                |
| `requestTimeout`      | Request timeout in milliseconds                    | `30000` (30s)                                |

### Step 4: Create the Remote Server Config

Copy the example and edit it to match your setup:

```bash
cp remote.config.example.json .mcp-secure-proxy/remote.config.json
```

Edit `.mcp-secure-proxy/remote.config.json`. This is where you define your callers, their connections, custom connectors, and secrets.

The config is **caller-centric** — each caller is identified by their public key and explicitly declares which connections they can access.

#### Example: Single caller with a built-in connection

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
  "callers": {
    "my-laptop": {
      "name": "Personal Laptop",
      "peerKeyDir": "/absolute/path/to/.mcp-secure-proxy/keys/peers/my-laptop",
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
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
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

| Field                | Description                                                                                                                                  | Default                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `host`               | Network interface to bind to. Use `0.0.0.0` for all interfaces or `127.0.0.1` for local only                                                 | `127.0.0.1`                     |
| `port`               | Port to listen on                                                                                                                            | `9999`                          |
| `localKeysDir`       | Absolute path to the remote server's own keypair                                                                                             | `.mcp-secure-proxy/keys/remote` |
| `connectors`         | Array of custom connector definitions, each with an `alias` for referencing from callers (see [Connector Definition](#connector-definition)) | `[]`                            |
| `callers`            | Per-caller access control. Keys are caller aliases used in audit logs (see [Caller Definition](#caller-definition))                          | `{}`                            |
| `rateLimitPerMinute` | Max requests per minute per session                                                                                                          | `60`                            |

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

| Field         | Required | Description                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peerKeyDir`  | Yes      | Path to this caller's public key files (`signing.pub.pem` + `exchange.pub.pem`)                                                                   |
| `connections` | Yes      | Array of connection names — references built-in templates (e.g., `"github"`) or custom connector aliases                                          |
| `name`        | No       | Human-readable name for audit logs                                                                                                                |
| `env`         | No       | Per-caller environment variable overrides (see [env overrides example](#example-per-caller-env-overrides-shared-connector-different-credentials)) |

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

The `.mcp.json` requires the `MCP_CONFIG_DIR` environment variable to be set so the proxy can locate its config and keys. Set it to the absolute path of your `.mcp-secure-proxy/` directory:

```bash
export MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy
```

**Alternative: manual registration**

If you prefer not to use auto-discovery, register the MCP server directly:

```bash
claude mcp add secure-proxy \
  --transport stdio --scope local \
  -e MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy \
  -- node /absolute/path/to/mcp-secure-proxy/dist/mcp/server.js
```

After connecting (either via auto-discovery or manual registration), the proxy will automatically perform the encrypted handshake with the remote server on first use.

## MCP Tools

Once connected, Claude Code gets access to three tools:

### `secure_request`

Make an authenticated HTTP request through the encrypted proxy. Route-level headers (e.g., `Authorization`) are injected automatically by the remote server.

```
method: GET | POST | PUT | PATCH | DELETE
url: Full URL (may contain ${VAR} placeholders)
headers: Optional additional headers
body: Optional request body
```

### `list_routes`

List all available routes for the current caller. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names. Different callers may see different routes based on their `connections` configuration.

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
mcp-secure-proxy/
├── .claude-plugin/              # Plugin metadata
│   ├── plugin.json              # Plugin manifest (name, version, description)
│   └── marketplace.json         # Marketplace catalog for distribution
├── .mcp.json                    # MCP server config (used by plugin system + auto-discovery)
├── dist/                        # Compiled JavaScript (built via `npm run build` or `postinstall`)
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
│   └── ...                     # 15 templates total
├── mcp/
│   └── server.ts               # Local MCP proxy server (stdio transport)
├── remote/
│   ├── server.ts               # Remote secure server (Express HTTP)
│   ├── server.test.ts          # Unit tests
│   └── server.e2e.test.ts      # End-to-end tests
└── shared/
    ├── config.ts               # Config loading/saving, caller & route resolution
    ├── connections.ts           # Connection template loading
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

- **Zero secrets on the client** — the local MCP proxy never sees API keys or tokens
- **Mutual authentication** — both sides prove their identity using Ed25519 signatures before any data is exchanged
- **End-to-end encryption** — all requests/responses are encrypted with AES-256-GCM session keys derived via X25519 ECDH
- **Replay protection** — monotonic counters prevent replay attacks
- **Session isolation** — each handshake produces unique session keys with a 30-minute TTL
- **Per-caller access control** — each caller only sees and can use the connections explicitly assigned to them
- **Per-caller credential isolation** — callers sharing the same connector can have different credentials via `env` overrides
- **Endpoint allowlisting** — the remote server only proxies requests to explicitly configured URL patterns
- **Rate limiting** — configurable per-session request rate limiting (default: 60/min)
- **Audit logging** — all operations are logged with caller identity, session ID, and timestamps
- **File permissions** — private keys are saved with `0600`, directories with `0700`

## License

ISC
