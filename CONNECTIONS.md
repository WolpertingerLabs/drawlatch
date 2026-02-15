# Connections (Pre-built Route Templates)

Instead of manually configuring routes for popular APIs, you can use **connections** — pre-built route templates that ship with the package. Reference them by name in `remote.config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
  "authorizedPeersDir": "/absolute/path/to/.mcp-secure-proxy/keys/peers/authorized-clients",
  "connections": ["github", "stripe"],
  "routes": [],
  "rateLimitPerMinute": 60
}
```

Connection routes are loaded at startup and appended **after** your manual routes. Since route matching returns the first match, your manual routes always take priority — you can override any connection by defining your own route with overlapping endpoint patterns.

## Available Connections

| Connection | API | Required Environment Variable(s) | Auth Method |
|---|---|---|---|
| `github` | [GitHub REST API](https://docs.github.com/en/rest) | `GITHUB_TOKEN` | Bearer token header |
| `stripe` | [Stripe Payments API](https://docs.stripe.com/api) | `STRIPE_SECRET_KEY` | Bearer token header |
| `trello` | [Trello Boards API](https://developer.atlassian.com/cloud/trello/rest/) | `TRELLO_API_KEY`, `TRELLO_TOKEN` | Query parameters (see note) |

> **Trello note:** The Trello API uses query parameter authentication rather than headers. Include `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` in your request URLs — the `${VAR}` placeholders are resolved automatically from the route's secrets.

## Example: Connections with environment variables

Set the required environment variables on the remote server (via `.env` file, shell export, or your deployment platform), then reference the connections:

```bash
# .env on the remote server
GITHUB_TOKEN=ghp_your_github_token_here
STRIPE_SECRET_KEY=sk_live_your_stripe_key_here
```

```json
{
  "connections": ["github", "stripe"],
  "routes": []
}
```

That's it — the connection templates handle endpoint patterns, auth headers, docs URLs, and OpenAPI specs automatically.

## Example: Mixing connections and custom routes

You can use connections alongside manually defined routes. Manual routes are checked first, so they take priority:

```json
{
  "connections": ["github"],
  "routes": [
    {
      "name": "Internal API",
      "allowedEndpoints": ["http://localhost:4567/**"],
      "headers": { "Authorization": "Bearer ${INTERNAL_TOKEN}" },
      "secrets": { "INTERNAL_TOKEN": "${INTERNAL_TOKEN}" }
    }
  ]
}
```

Connection templates are stored as JSON files in `src/connections/`. You can inspect them to see exactly what headers, endpoints, and secrets each connection configures.
