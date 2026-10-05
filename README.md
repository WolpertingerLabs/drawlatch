# Drawlatch

> **Alpha software:** expect breaking changes between updates.

Drawlatch gives AI agents authenticated access to external APIs without giving them the credentials. A daemon holds your secrets and makes the API calls. Agents reach it through a local MCP server over an end-to-end encrypted, mutually authenticated channel, and can only call the URL patterns each connection allows.

- **28 pre-built connections** (GitHub, Slack, Discord, Stripe, Notion, Linear, OpenAI, …) plus your own custom connectors. See [CONNECTIONS.md](CONNECTIONS.md).
- **Per-caller access control.** Each agent identity (caller) sees only its own connections and secrets.
- **Real-time events.** WebSocket, webhook, and polling listeners buffer events for agents to read. See [INGESTORS.md](INGESTORS.md).
- **Admin dashboard** for callers, connections, secrets, and listeners, served by the daemon itself.

**Using [Callboard](https://github.com/WolpertingerLabs/callboard)?** Drawlatch is built in. Callboard manages connections, secrets, and agent identities through its UI, so you don't need to set up drawlatch separately.

## How it works

```
Claude Code ◄─ stdio ─► MCP server (local, no secrets) ◄─ HTTP + E2EE ─► drawlatch daemon (holds secrets) ─ HTTPS ─► API
```

The local MCP server holds only its caller keypair and the daemon's public keys. Each session starts with a handshake: Ed25519 signatures for mutual authentication, then X25519 ECDH to derive AES-256-GCM session keys. The daemon matches each request to an allowlisted connection, injects that connection's headers and secrets, and makes the call. All crypto uses Node's built-in `crypto` module.

## Quick start (single machine)

Requires Node.js 22 or later.

```bash
npm install -g @wolpertingerlabs/drawlatch

drawlatch init            # server keypair, configs and .env in ~/.drawlatch
drawlatch set-password    # dashboard password (at least 8 characters)
drawlatch start           # start the daemon in the background
```

`init` is idempotent and never overwrites existing files. It writes `"host": "0.0.0.0"`, so the daemon listens on every interface (the dashboard is password-protected; set `"host": "127.0.0.1"` in `~/.drawlatch/remote.config.json` for loopback only). It does not create a caller. Create one next.

**Create a caller.** The local MCP server authenticates as the caller named by `MCP_KEY_ALIAS` (default: `default`), using the keypair in `~/.drawlatch/keys/callers/<alias>/`. Either:

- **Dashboard:** open `http://127.0.0.1:9999/`, go to **Callers → New caller**, name it `default`, then on **Connections** enable `github` and set `GITHUB_TOKEN`. Changes apply immediately.
- **CLI:**

  ```bash
  drawlatch generate-keys caller default
  # In ~/.drawlatch/remote.config.json, set:  "callers": { "default": { "connections": ["github"] } }
  echo 'DEFAULT_GITHUB_TOKEN=ghp_your_token' >> ~/.drawlatch/.env   # secrets are prefixed with the caller alias
  drawlatch restart
  ```

**Register the MCP server with Claude Code:**

```bash
claude mcp add drawlatch -- node "$(npm root -g)/@wolpertingerlabs/drawlatch/dist/mcp/server.js"
```

Add `-e MCP_KEY_ALIAS=<alias>` (before `--`) to use a caller other than `default`, and `-e MCP_CONFIG_DIR=/abs/path` for a config directory other than `~/.drawlatch`. Use absolute paths: a `~` inside an MCP `env` value is not expanded.

**Check the setup:**

```bash
drawlatch doctor    # config, keys, required secrets, daemon health
drawlatch status    # PID, port, uptime, active sessions, dashboard URL
```

This repo is also a Claude Code plugin marketplace (`.claude-plugin/`): `/plugin marketplace add WolpertingerLabs/drawlatch`, then `/plugin install drawlatch@drawlatch`. Its MCP server is named `secure-proxy` and passes `MCP_CONFIG_DIR` and `MCP_KEY_ALIAS` through from your environment.

## Daemon and MCP server on different machines

The MCP server reads PEM files only, so you exchange public keys by hand:

1. **Client machine:** install drawlatch, run `drawlatch generate-keys caller laptop`, and create `~/.drawlatch/proxy.config.json` with `"remoteUrl": "http://<daemon-host>:9999"` (see [Proxy config](#proxy-config-proxyconfigjson)). Don't run `init` here; it would create an unrelated server keypair.
2. Copy the client's `keys/callers/laptop/*.pub.pem` to the daemon machine's `~/.drawlatch/keys/callers/laptop/`, and add `"laptop": { "connections": [...] }` to its `callers`.
3. Copy the daemon's `keys/server/*.pub.pem` to the client's `~/.drawlatch/keys/server/`.
4. `drawlatch restart` on the daemon, then register the MCP server on the client with `-e MCP_KEY_ALIAS=laptop`.

Traffic is encrypted end to end, but the dashboard cookie is not marked `secure`. Put the daemon behind a TLS-terminating proxy if you expose it beyond a trusted network.

**Callboard instances** use credential bundles instead: `drawlatch issue-caller <alias> -o <alias>.drawlatch-caller.json` (or **Issue credentials** on the dashboard's caller page), then import the file in Callboard. On the same host, `--into <callboard keys dir>` writes the key files directly. Issuing mints a new keypair and keeps only its public half, so **issuing for an existing alias rotates its keys** and deletes any private key drawlatch held for it. After a CLI issue, `drawlatch restart` so a running daemon accepts the new key; dashboard issues apply immediately.

A co-located Callboard can also provision itself. When the daemon starts with `DRAWLATCH_LOCAL_CALLER_KEYS_DIR` set and the caller named by `DRAWLATCH_LOCAL_CALLER_ALIAS` (default `callboard-local`; Callboard sets `default`) is missing from config or has no keys, drawlatch issues it and writes the caller keys to `<dir>/callers/<alias>/` and the server public keys to `<dir>/server/`. `DRAWLATCH_LOCAL_CALLER_CONNECTIONS` (comma-separated) sets its connections. If that is unset, it keeps the existing entry's connections or copies the `default` caller's.

## MCP tools

The local MCP server exposes these tools. Every call goes through the encrypted channel and runs as the authenticated caller.

| Tool | Purpose |
| --- | --- |
| `secure_request` | HTTP request to an allowlisted URL. Connection headers are injected for you. `${VAR}` placeholders in the URL and headers resolve server-side from the matched connection's secrets (in the body only if the connection sets `resolveSecretsInBody`). Supports multipart uploads from local files (25 MB per file, 50 MB per base64-encoded request) and a per-call `timeoutMs`. |
| `list_routes` | The caller's connections: docs links, allowed endpoint patterns, the *names* of secrets that are set, auto-injected header names, timeouts, listener info. |
| `test_connection` | Run a connection's built-in credential check. Some cost a little credit; see [CONNECTIONS.md](CONNECTIONS.md#available-connections). |
| `list_connection_templates` | All built-in templates, with which are enabled for this caller and which secrets are set (booleans). Custom connectors aren't listed. |
| `set_connection_enabled` | Enable or disable a connection for this caller. |
| `set_secrets` | Set or delete (empty string) this caller's secrets. Write-only. |
| `get_secret_status` | Which required and optional secrets are set for a built-in connection (booleans). |
| `poll_events` | Read buffered listener events after a cursor. |
| `ingestor_status` | State, buffer size, event counts, and errors for this caller's listeners. |
| `control_listener` | Start, stop, or restart a listener. |
| `list_listener_configs` | Configurable listener fields per connection. |
| `get_listener_params` / `set_listener_params` | Read or change listener parameters. |
| `resolve_listener_options` | Fetch dynamic choices for a listener field (for example, your Trello boards). |
| `list_listener_instances` / `delete_listener_instance` | Manage multi-instance listeners. |
| `test_ingestor` | Check a listener's configuration and credentials. |

Note that `set_secrets` and `set_connection_enabled` let an agent change its own caller's configuration. It still can't read secret values or reach URLs outside the allowlists.

The daemon also accepts `wait_for_events`, a long-poll over all of a caller's event streams. The local MCP server doesn't expose it; long-running clients such as Callboard call it over the encrypted channel. See [INGESTORS.md](INGESTORS.md#reading-events).

## Configuration

### Config directory

Everything lives in `~/.drawlatch/`, or `$MCP_CONFIG_DIR` if set:

```
remote.config.json     daemon config: callers, custom connectors, host/port, rate limit, tunnel
proxy.config.json      local MCP server config: daemon URL and timeouts
.env                   secrets (mode 0600), plus the dashboard password hash
keys/server/           the daemon's Ed25519 + X25519 keypair
keys/callers/<alias>/  one keypair per caller (public half only, when issued as a bundle)
logs/drawlatch.log     daemon log (drawlatch logs)
data/sessions.json     dashboard login sessions
drawlatch.pid          PID of the background daemon
```

Each key directory holds `signing.{pub,key}.pem` and `exchange.{pub,key}.pem`. Private keys are written `0600` and key directories `0700`. On startup the daemon moves the legacy `keys/local`, `keys/remote`, and `keys/peers/*` layouts into this one.

### Daemon config (`remote.config.json`)

| Field | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` (`init` writes `0.0.0.0`) | Bind address. Env override: `DRAWLATCH_HOST`, or `drawlatch start --host`. |
| `port` | `9999` | Listen port. Env override: `DRAWLATCH_PORT`, or `--port`. |
| `rateLimitPerMinute` | `240` (`init` writes `60`) | Encrypted requests per minute per session. Over the limit, the daemon returns `429` with `Retry-After`. |
| `callers` | `{}` | Caller aliases and what each may use (see below). |
| `connectors` | `[]` | Custom connector definitions (see below). |
| `tunnel` | `false` | Start a Cloudflare quick tunnel at boot. Env override: `DRAWLATCH_TUNNEL=1`, or `--tunnel`. |

The daemon re-reads `remote.config.json` for each new session and after dashboard changes. Hand edits that add callers or change listeners need `drawlatch restart`.

### Callers

```json
{
  "callers": {
    "default": { "connections": ["github", "stripe", "internal-api"] },
    "ci": { "name": "CI runner", "connections": ["github"] }
  }
}
```

| Field | Description |
| --- | --- |
| `connections` | Required. Built-in connection names or custom connector aliases. |
| `name` | Display name for logs and the dashboard. |
| `env` | Per-caller secret values (see [Secrets](#secrets)). |
| `ingestorOverrides`, `listenerInstances` | Listener settings ([INGESTORS.md](INGESTORS.md#per-caller-listener-settings)). |

Caller public keys are read from `keys/callers/<alias>/`. Aliases must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.

### Secrets

Connections reference secrets as `${NAME}` (for example, `${GITHUB_TOKEN}`). For caller `<alias>`, the daemon looks up `NAME` in this order:

1. A literal value in the caller's `env` map: `"env": { "GITHUB_TOKEN": "ghp_..." }`.
2. The environment variable `<ALIAS>_<NAME>`, with the alias uppercased and `-` replaced by `_`. Examples: `DEFAULT_GITHUB_TOKEN`, `MY_AGENT_GITHUB_TOKEN`.

A bare `GITHUB_TOKEN` is never used. This keeps one caller from picking up another's credentials. The daemon loads `.env` at startup, so restart after editing it by hand. The dashboard and `set_secrets` write `<ALIAS>_<NAME>` to `.env` and apply the change immediately.

If a secret isn't set, its placeholder is sent literally (for example, `Authorization: Bearer ${GITHUB_TOKEN}`), and the upstream API will usually answer `401`. `drawlatch doctor`, `drawlatch config`, and the dashboard's Secrets page show what's missing. They check only secrets used in a connection's headers, so they don't flag a token that goes in the URL (Telegram, Trello).

> **Known issue:** an `env` value that redirects to another variable, such as `"GITHUB_TOKEN": "${ALICE_TOKEN}"`, is not resolved, and the secret is reported as set when it isn't. Use a literal value or the prefixed variable name instead.

### Custom connectors

Use these for APIs without a built-in template, or to override one: a connector whose `alias` matches a built-in name replaces that template.

```json
{
  "connectors": [
    {
      "alias": "internal-api",
      "name": "Internal Admin API",
      "allowedEndpoints": ["https://admin.internal.example/**"],
      "headers": { "Authorization": "Bearer ${ADMIN_KEY}" },
      "secrets": { "ADMIN_KEY": "${ADMIN_KEY}" }
    }
  ]
}
```

With this connector, caller `default` reads `ADMIN_KEY` from `DEFAULT_ADMIN_KEY`.

| Field | Description |
| --- | --- |
| `alias` | Required. Name referenced from a caller's `connections`. |
| `allowedEndpoints` | Required. URL globs: `*` matches within a path segment, `**` across segments. An empty list matches nothing. |
| `headers` | Headers injected into every request. `${VAR}` resolves against `secrets`. A request that sets the same header itself is rejected. |
| `secrets` | `NAME → value`. The value is a literal, or `${VAR}` resolved per caller as in [Secrets](#secrets). |
| `resolveSecretsInBody` | Resolve `${VAR}` in request bodies. Default `false`, which stops an agent from writing a placeholder into a resource and reading the secret back. |
| `requestTimeoutMs` | Default outbound timeout for this API, and the most a caller may request (see [Request timeouts](#request-timeouts)). |
| `name`, `description`, `docsUrl`, `openApiUrl` | Shown to agents by `list_routes`. |
| `testConnection`, `ingestor`, `listenerConfig`, `testIngestor` | Credential test and event listener definitions. Built-in templates in `src/connections/` are the reference. |

### Proxy config (`proxy.config.json`)

Read by the local MCP server, which won't connect without this file. `init` writes it. Fields missing from the file fall back to these defaults.

| Field | Default | Description |
| --- | --- | --- |
| `remoteUrl` | `http://localhost:9999` (`init` writes `http://127.0.0.1:9999`) | Daemon URL. |
| `connectTimeout` | `10000` | Handshake timeout (ms). |
| `requestTimeout` | `185000` | Local → daemon deadline (ms) for calls that don't pass `timeoutMs`. It also caps the daemon's outbound budget. |

Keys are read from `keys/callers/<MCP_KEY_ALIAS or "default">/` and `keys/server/`.

### Request timeouts

A proxied call has three nested deadlines. The innermost fires first, because only the daemon's outbound fetch can actually cancel the upstream call:

| Layer | Deadline | Default |
| --- | --- | --- |
| daemon → upstream API | per-call `timeoutMs`, else the connection's `requestTimeoutMs`, else 25 s. Capped by the connection's `requestTimeoutMs` (or 290 s), then by the local budget. | `25000` |
| MCP server → daemon | `timeoutMs + 5000`, else `requestTimeout` | `185000` |
| MCP client → MCP server | your client's tool timeout (`MCP_TOOL_TIMEOUT` in Claude Code) | `60000` |

- The MCP server sends the daemon an outbound budget of its own deadline minus 5 s, so the outbound leg always finishes first. Passing `timeoutMs` widens the local deadline to match.
- `exa`, `firecrawl`, and `parallel` allow up to 120 s, and `perplexity` up to 180 s. All four exceed the MCP client's 60 s default, so raise `MCP_TOOL_TIMEOUT` to use the full ceiling. They already fit under the default `requestTimeout`. For long jobs, prefer the API's async submit-and-poll endpoints.
- `list_routes` reports each connection's `defaultTimeoutMs` and `maxTimeoutMs` under the current budget.
- The 290 s outbound maximum sits below undici's internal 300 s headers timeout, which would otherwise fire first with an opaque error.
- A timed-out call is cancelled at the socket and reported as `Upstream request timed out after <n>ms`. If the local budget was the binding limit, the error names the setting to raise. A host that never accepts the connection is reported as `Upstream never accepted the connection`.
- The MCP server accepts `timeoutMs` only as a positive integer up to 290000. The daemon treats invalid values from other clients as unset. A malformed `requestTimeoutMs` on a connection falls back to 25 s; it doesn't remove the ceiling.

### Webhooks and the tunnel

Webhook listeners (GitHub, Stripe, Trello) receive `POST /webhooks/<path>` on the daemon's port, so the daemon must be reachable from the internet. `drawlatch start --tunnel` (or `"tunnel": true`) runs a Cloudflare quick tunnel; [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed. The tunnel URL appears in `drawlatch status`, and the daemon sets any unset callback-URL variable a webhook template references (for example, `TRELLO_CALLBACK_URL`) before starting listeners. Details: [INGESTORS.md](INGESTORS.md#webhooks).

## Admin dashboard

The daemon serves a web dashboard and its JSON API from the same port as the MCP protocol: `http://127.0.0.1:9999/` by default. From it you can create, issue, and delete callers; enable connections; set secrets; configure, test, and control listeners; and watch events, ingestors, sessions, and a secrets matrix. Connection and secret changes apply to open sessions immediately. Running listeners pick up new secrets, or a newly enabled connection, only when they are (re)started: use the listener controls or `drawlatch restart`. Listener parameter changes restart the listener.

**Password.** The dashboard stays locked until a password is set. `drawlatch set-password` (alias `change-password`) prompts on a TTY or reads the password twice from stdin (`printf '%s\n%s\n' "$PW" "$PW" | drawlatch set-password`). It stores a scrypt hash and salt in `.env` as `AUTH_PASSWORD_HASH` / `AUTH_PASSWORD_SALT`. Restart the daemon after setting it from the CLI. Changing it from the dashboard (**Change password**, `/settings/password`) applies immediately and signs out every other session.

**Security.**

- The password, not loopback, is the trust boundary. That's why the daemon can bind `0.0.0.0`.
- The session cookie (`drawlatch_session`) is `httpOnly` and `sameSite=strict`, with a 7-day rolling expiry. It has no `secure` flag, so use a TLS-terminating proxy beyond a trusted network.
- Per-IP rate limits:
  - login and password change: 3/min combined
  - auth check and logout: 20/min
  - `/handshake`: 30/min
  - `/webhooks`: 120/min
  - `/health`: 60/min
  - `/api/admin`: 300/min, with credential issuance limited to 10/min
- Without a password, the MCP protocol still works. Login, auth checks, and `/api/admin/*` return `503`.

**API.** The dashboard is a client of `/api/admin/*`. Read endpoints report secrets as booleans only. Write endpoints:

- create, issue, and delete callers: `POST /callers`, `POST /callers/:alias/issue`, `DELETE /callers/:alias`
- enable a connection, set secrets, run tests, and control or configure listeners under `/callers/:alias/connections/:connection/…`
- toggle the tunnel flag: `PUT /tunnel` (takes effect on restart)

Connection and listener operations share their implementation with the MCP tools (`src/remote/tool-dispatch.ts`). The unauthenticated `GET /health` returns status, active session count, uptime, and the tunnel URL.

## CLI reference

```
drawlatch [command] [options]          (no command: status if running, else help)

init                     Create server keys, proxy/remote configs and .env (idempotent)
start                    Start the daemon in the background
    -f, --foreground       Run in the foreground (for process managers)
    -t, --tunnel           Also start a Cloudflare quick tunnel (requires cloudflared)
    --port <n>, --host <addr>
stop | restart           Stop (SIGTERM, then SIGKILL after 5s) / restart; restart keeps an active tunnel
status                   PID, address, dashboard URL, password state, uptime, health, sessions
logs                     Show the log (~/.drawlatch/logs/drawlatch.log)
    -n, --lines <n>        Lines to show (default 50)
    --follow               Keep tailing
    --requests             Include per-request [audit] lines (hidden by default)
watch [connection]       Stream listener events live (loopback only)
    --full                 Print full payloads instead of a 100-character preview
config                   Show effective config and per-caller secret status (--path: config file path)
doctor                   Check config, keys, required secrets and daemon health
generate-keys caller [alias]   Caller keypair in keys/callers/<alias>/ (default alias "default")
generate-keys server           Server keypair in keys/server/
generate-keys show <path>      Fingerprint of an existing keypair
issue-caller <alias>     Issue a caller credential bundle (for Callboard)
    --name <name>          Display name (default: keep existing, else the alias)
    --connections <a,b>    Connections (default: keep existing, else copy "default")
    --endpoint <url>       Daemon URL pinned in the bundle (default: this daemon's host:port)
    --passphrase           Encrypt the bundle's private keys (scrypt + AES-256-GCM)
    -o, --output <file>    Write to a 0600 file instead of stdout
    --into <keysDir>       Same host: write key files into a Callboard keys directory
set-password             Set the dashboard password (alias: change-password)
-h, --help / -v, --version
```

## Security model

- **Endpoint allowlisting:** requests go only to URLs matching the caller's connections.
- **Per-caller isolation:** each caller sees only its connections, and secrets resolve only from its own `env` or `<ALIAS>_`-prefixed variables.
- **No secrets on the client:** the MCP server never holds API credentials. Secret placeholders resolve server-side, in request bodies only when a connection opts in.
- **Mutual authentication:** Ed25519-signed handshake against a pinned server key and registered caller keys.
- **Encryption:** AES-256-GCM with per-session X25519 ECDH keys, and monotonic counters against replay.
- **Sessions** expire after 30 minutes idle.
- **Rate limits** apply per session (`rateLimitPerMinute`) and per IP on unauthenticated endpoints.
- **Audit log:** every request and response is logged with caller and session (`drawlatch logs --requests`).

## Package exports

Drawlatch is mainly a CLI and daemon. Hosts such as Callboard can import these subpaths; any other deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

| Export | Contents |
| --- | --- |
| `@wolpertingerlabs/drawlatch` | The MCP stdio server (`dist/mcp/server.js`). Importing it starts the server. |
| `…/shared/crypto` | Key generation, loading and fingerprints, `EncryptedChannel` |
| `…/shared/protocol` | `HandshakeInitiator` / `HandshakeResponder` and wire message types |
| `…/shared/migrations` | Idempotent config-dir migrations (`migrateKeyLayout`, `migrateConfigDir`) |
| `…/remote/server` | Daemon entry point. Resolve its path and run it with `node`; it isn't a library API. |
| `…/remote/caller-bootstrap` | `CALLER_ALIAS_REGEX` and caller creation and issuance helpers |
| `…/remote/admin-types` | Admin API types, including the caller bundle format (`CallerBundleV1`) |

## Development

```bash
npm install               # also builds (prepare script)
npm run build             # tsc + copy connection templates + build the dashboard
npm test                  # unit tests (vitest); npm run test:e2e for live-API tests (.env.e2e)
npm run lint              # eslint src/
npm run format            # prettier
npm run dev:remote        # daemon via tsx, config in ~/.drawlatch-dev
npm run dev:mcp           # MCP server via tsx, config in ~/.drawlatch-dev
```

```
bin/drawlatch.js          CLI
src/mcp/server.ts         local MCP stdio server
src/remote/server.ts      daemon: handshake, /request, webhooks, dashboard, admin API
src/remote/tool-dispatch.ts   tool implementations shared by MCP and the admin API
src/remote/ingestors/     WebSocket, webhook and poll listeners
src/connections/<category>/<name>.json   built-in connection templates
src/shared/               config, secrets, crypto, handshake protocol
src/auth/                 dashboard password and sessions
frontend/                 React + Vite dashboard (built to frontend/dist)
```

## License

MIT
