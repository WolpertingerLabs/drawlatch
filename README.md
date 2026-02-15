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

## Quick Start (Setup Scripts)

The fastest way to get started is using the interactive setup scripts:

```bash
npm install
npm run build

# On the remote server machine:
npm run setup:remote

# On your local machine:
npm run setup:local
```

The scripts will generate keys, configure connections, and print the `claude mcp add` command to register the MCP server.

## Manual Setup

If you prefer to configure everything manually (or need to automate the setup), follow the steps below.

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
        ├── authorized-clients/
        │   └── mcp-proxy/                     # One subdirectory per authorized client
        │       ├── signing.pub.pem            # Client's public signing key
        │       └── exchange.pub.pem           # Client's public exchange key
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

**From local to remote** — copy the proxy's public keys into the remote server's authorized clients directory:

```bash
mkdir -p .mcp-secure-proxy/keys/peers/authorized-clients/mcp-proxy

cp .mcp-secure-proxy/keys/local/signing.pub.pem \
   .mcp-secure-proxy/keys/peers/authorized-clients/mcp-proxy/signing.pub.pem

cp .mcp-secure-proxy/keys/local/exchange.pub.pem \
   .mcp-secure-proxy/keys/peers/authorized-clients/mcp-proxy/exchange.pub.pem
```

**From remote to local** — copy the remote server's public keys into the proxy's peer directory:

```bash
mkdir -p .mcp-secure-proxy/keys/peers/remote-server

cp .mcp-secure-proxy/keys/remote/signing.pub.pem \
   .mcp-secure-proxy/keys/peers/remote-server/signing.pub.pem

cp .mcp-secure-proxy/keys/remote/exchange.pub.pem \
   .mcp-secure-proxy/keys/peers/remote-server/exchange.pub.pem
```

> **Tip:** If the proxy and remote server are on different machines, securely transfer only the `*.pub.pem` files (e.g., via `scp`). You can authorize multiple proxy clients by creating additional subdirectories under `authorized-clients/` (e.g., `authorized-clients/my-laptop/`, `authorized-clients/ci-server/`).

### Step 3: Create the Local Proxy Config

Create `.mcp-secure-proxy/proxy.config.json`:

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "localKeysDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/local",
  "remotePublicKeysDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/peers/remote-server",
  "connectTimeout": 10000,
  "requestTimeout": 30000
}
```

| Field | Description | Default |
|---|---|---|
| `remoteUrl` | URL of the remote secure server | `http://localhost:9999` |
| `localKeysDir` | Absolute path to the proxy's own keypair directory | `.mcp-secure-proxy/keys/local` |
| `remotePublicKeysDir` | Absolute path to the remote server's public keys | `.mcp-secure-proxy/keys/peers/remote-server` |
| `connectTimeout` | Handshake timeout in milliseconds | `10000` (10s) |
| `requestTimeout` | Request timeout in milliseconds | `30000` (30s) |

### Step 4: Create the Remote Server Config

Create `.mcp-secure-proxy/remote.config.json`. This is where you define your API routes, secrets, and auto-injected headers.

#### Example: Single API with a Bearer token

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/remote",
  "authorizedPeersDir": "/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy/keys/peers/authorized-clients",
  "routes": [
    {
      "name": "GitHub API",
      "description": "GitHub REST API v3",
      "docsUrl": "https://docs.github.com/en/rest",
      "openApiUrl": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      "allowedEndpoints": [
        "https://api.github.com/**"
      ],
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
      },
      "secrets": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  ],
  "rateLimitPerMinute": 60
}
```

#### Example: Multiple routes with different auth strategies

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
  "authorizedPeersDir": "/absolute/path/to/.mcp-secure-proxy/keys/peers/authorized-clients",
  "routes": [
    {
      "name": "OpenAI API",
      "description": "OpenAI chat completions and embeddings",
      "allowedEndpoints": [
        "https://api.openai.com/**"
      ],
      "headers": {
        "Authorization": "Bearer ${OPENAI_API_KEY}"
      },
      "secrets": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    },
    {
      "name": "Stripe API",
      "description": "Stripe payments API",
      "docsUrl": "https://stripe.com/docs/api",
      "allowedEndpoints": [
        "https://api.stripe.com/**"
      ],
      "headers": {
        "Authorization": "Bearer ${STRIPE_SECRET_KEY}"
      },
      "secrets": {
        "STRIPE_SECRET_KEY": "sk_live_your_actual_key_here"
      }
    },
    {
      "name": "Internal API",
      "description": "Public endpoints on the internal API (no auth required)",
      "allowedEndpoints": [
        "http://localhost:4567/public/**"
      ]
    }
  ],
  "rateLimitPerMinute": 60
}
```

#### Example: Route with inline secret values (no env vars)

```json
{
  "host": "127.0.0.1",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
  "authorizedPeersDir": "/absolute/path/to/.mcp-secure-proxy/keys/peers/authorized-clients",
  "routes": [
    {
      "name": "Test API Server",
      "description": "Test API Server for testing the MCP secure proxy",
      "docsUrl": "http://localhost:4567/docs",
      "openApiUrl": "http://localhost:4567/openapi.json",
      "allowedEndpoints": [
        "http://localhost:4567/auth/**",
        "http://localhost:4567/passthrough/**"
      ],
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      },
      "secrets": {
        "API_TOKEN": "test-secret-key-12345"
      }
    }
  ],
  "rateLimitPerMinute": 60
}
```

#### Remote Config Reference

| Field | Description | Default |
|---|---|---|
| `host` | Network interface to bind to. Use `0.0.0.0` for all interfaces or `127.0.0.1` for local only | `127.0.0.1` |
| `port` | Port to listen on | `9999` |
| `localKeysDir` | Absolute path to the remote server's own keypair | `.mcp-secure-proxy/keys/remote` |
| `authorizedPeersDir` | Directory containing authorized client public keys (one subdirectory per client) | `.mcp-secure-proxy/keys/peers/authorized-clients` |
| `routes` | Array of route definitions (see below) | `[]` |
| `rateLimitPerMinute` | Max requests per minute per session | `60` |

#### Route Definition

| Field | Required | Description |
|---|---|---|
| `allowedEndpoints` | Yes | Array of glob patterns for allowed URLs (e.g., `https://api.example.com/**`) |
| `name` | No | Human-readable name (e.g., `"GitHub API"`) |
| `description` | No | Short description of what the route provides |
| `docsUrl` | No | URL to API documentation |
| `openApiUrl` | No | URL to OpenAPI/Swagger spec (preferred over `docsUrl` for `get_route_docs`) |
| `headers` | No | Headers to auto-inject. Values may contain `${VAR}` placeholders resolved from `secrets` |
| `secrets` | No | Key-value pairs. Values can be literal strings or `${ENV_VAR}` references resolved from environment variables at startup |

#### How Secrets Work

Secret values in the `secrets` map are resolved at server startup:

- **Literal values** — used as-is: `"API_TOKEN": "sk_live_abc123"`
- **Environment variable references** — resolved from the server's environment: `"API_TOKEN": "${API_TOKEN}"`

Header values can reference secrets using `${VAR}` placeholders:

```json
"headers": {
  "Authorization": "Bearer ${API_TOKEN}"
}
```

The placeholder `${API_TOKEN}` is resolved against the route's resolved `secrets` map. This means the actual secret value is never exposed to the local proxy or Claude Code — it only exists on the remote server.

### Step 5: Start the Servers

**Start the remote server:**

```bash
# Development (with hot reload via tsx)
npm run dev:remote

# Production (requires `npm run build` first)
npm run start:remote
```

**Register the local MCP proxy with Claude Code:**

```bash
# Development (tsx)
claude mcp add secure-proxy \
  --transport stdio --scope local \
  -e MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy \
  -- npx tsx /absolute/path/to/mcp-secure-proxy/src/mcp/server.ts

# Production (compiled)
claude mcp add secure-proxy \
  --transport stdio --scope local \
  -e MCP_CONFIG_DIR=/absolute/path/to/mcp-secure-proxy/.mcp-secure-proxy \
  -- node /absolute/path/to/mcp-secure-proxy/dist/mcp/server.js
```

> **Note:** The `MCP_CONFIG_DIR` environment variable tells the proxy where to find its config and keys. Use absolute paths so it works regardless of the working directory Claude Code spawns the process from.

After adding the MCP server, restart Claude Code. The proxy will automatically perform the encrypted handshake with the remote server on first use.

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

List all available routes on the remote server. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names.

### `get_route_docs`

Fetch API documentation for a specific route by index (from `list_routes`). The remote server fetches the docs on the agent's behalf. If the route has an OpenAPI spec URL, that is returned; otherwise the general docs URL content is fetched.

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

```
src/
├── cli/                        # Setup and key generation CLIs
│   ├── generate-keys.ts        # Standalone key generation
│   ├── helpers.ts              # Shared CLI utilities
│   ├── setup-local.ts          # Interactive local proxy setup
│   └── setup-remote.ts         # Interactive remote server setup
├── mcp/
│   └── server.ts               # Local MCP proxy server (stdio transport)
├── remote/
│   ├── server.ts               # Remote secure server (Express HTTP)
│   ├── server.test.ts          # Unit tests
│   └── server.e2e.test.ts      # End-to-end tests
└── shared/
    ├── config.ts               # Config loading/saving, route resolution
    ├── config.test.ts          # Config tests
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
- **Endpoint allowlisting** — the remote server only proxies requests to explicitly configured URL patterns
- **Rate limiting** — configurable per-session request rate limiting (default: 60/min)
- **File permissions** — private keys are saved with `0600`, directories with `0700`

## License

ISC
