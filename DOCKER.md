# Docker Deployment — Remote Server

Run the secrets-holding remote server in a hardened Docker container while the MCP proxy (client) runs on bare metal.

## Prerequisites

- **Docker** and **Docker Compose** (v2)
- Keys and config already generated via `npm run setup` on the host
- A `.env` file with your secret values (see below)

## Quick Start

```bash
# 1. Generate keys and config (if not done already)
npm run setup

# 2. Set the remote server host to 0.0.0.0 for Docker
#    Edit ~/.mcp-secure-proxy/config.json and set:
#    "remote": { "host": "0.0.0.0", ... }

# 3. Create your .env file with actual secret values
cp .env.example .env
# Edit .env and fill in your API keys / tokens

# 4. Build and start the container
docker compose up -d

# 5. Verify it's running
curl http://localhost:9999/health
docker compose logs
```

## How Secrets Work

```
Host: .env file                          Docker container
──────────────                           ─────────────────
OPENAI_API_KEY=sk-abc123  ──env_file──>  process.env.OPENAI_API_KEY = "sk-abc123"
                                          |
Host: config.json (mounted :ro)          resolveSecrets() matches ${OPENAI_API_KEY}
"OPENAI_API_KEY": "${OPENAI_API_KEY}"     -> resolves to "sk-abc123" in memory
                                          |
                                         secrets map used for placeholder injection
                                         (never written to disk inside container)
```

- **`.env`** on the host holds actual secret values. It is loaded by docker-compose and injected as environment variables into the container process.
- **`config.json`** on the host contains only `${VAR_NAME}` references, not actual values. It is volume-mounted read-only.
- **Inside the container**, `resolveSecrets()` reads `process.env` to resolve the `${VAR_NAME}` placeholders into actual values — these exist only in process memory.
- **The Docker image** never contains secrets. They are injected at runtime only.

### Future: Secrets Providers

The `${VAR_NAME}` indirection means you can swap `.env` for a secrets provider (Infisical, HashiCorp Vault, AWS Secrets Manager, etc.) without changing the application code. The provider just needs to populate the container's environment variables.

## Example `config.json` for Docker

The remote server section should look like this:

```json
{
  "remote": {
    "host": "0.0.0.0",
    "port": 9999,
    "secrets": {
      "OPENAI_API_KEY": "${OPENAI_API_KEY}",
      "GITHUB_TOKEN": "${GITHUB_TOKEN}"
    },
    "allowedEndpoints": [
      "https://api.openai.com/**",
      "https://api.github.com/**"
    ],
    "rateLimitPerMinute": 60
  }
}
```

**Important:** `"host": "0.0.0.0"` is required inside Docker so the server binds to all interfaces within the container. External access is restricted by the docker-compose port mapping (`127.0.0.1:9999:9999`), which only allows connections from the host's loopback interface.

## Volume Permissions

The container runs as UID `1001` (user `mcpproxy`). The mounted config and key files must be readable by this UID. Two approaches:

**Option A:** Set ownership on the host:
```bash
chown -R 1001:1001 ~/.mcp-secure-proxy/
```

**Option B:** Override the container user to match your host UID:
```yaml
# In docker-compose.yml, add under remote-server:
user: "${UID:-1000}:${GID:-1000}"
```

## Security Layers

| Layer | What it does |
|-------|-------------|
| `127.0.0.1:9999` port binding | Container only reachable from host localhost |
| `:ro` volume mount | Config and keys are read-only inside container |
| `read_only: true` | Immutable container filesystem |
| `cap_drop: ALL` | Zero Linux capabilities |
| `no-new-privileges` | Prevents privilege escalation |
| Non-root user (UID 1001) | Server process has no root access |
| `dumb-init` PID 1 | Proper SIGTERM forwarding and zombie reaping |
| Health check | Automatic restart on failure via `restart: unless-stopped` |

## Commands

```bash
# Build the image
docker compose build

# Start in background
docker compose up -d

# View logs
docker compose logs -f remote-server

# Check health
curl http://localhost:9999/health

# Stop gracefully
docker compose down

# Rebuild after code changes
docker compose up -d --build
```

## Custom Config Directory

If your config is not in `~/.mcp-secure-proxy/`, set `MCP_CONFIG_DIR`:

```bash
MCP_CONFIG_DIR=/path/to/config docker compose up -d
```

## Troubleshooting

**"Connection refused" from MCP proxy:**
- Ensure `config.json` has `"host": "0.0.0.0"` (not `"127.0.0.1"`) in the remote section
- Ensure the container is running: `docker compose ps`
- Check logs: `docker compose logs remote-server`

**"Permission denied" on key files:**
- See [Volume Permissions](#volume-permissions) above
- Verify: `docker compose exec remote-server ls -la /config/keys/remote/`

**Secrets not resolving:**
- Ensure your `.env` file exists and has values filled in
- Check logs for `[secrets] Warning: env var ... not found` messages
- Verify env vars inside container: `docker compose exec remote-server env | grep -v "=" | head` (or check logs for the `Loaded N secrets` line)
