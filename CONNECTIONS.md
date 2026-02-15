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
| `hex` | [Hex API](https://learn.hex.tech/docs/api/api-overview) | `HEX_TOKEN` | Bearer token header |
| `devin` | [Devin AI API](https://docs.devin.ai/api-reference/overview) | `DEVIN_API_KEY` | Bearer token header |
| `slack` | [Slack Web API](https://docs.slack.dev/apis/web-api) | `SLACK_BOT_TOKEN` | Bearer token header |
| `linear` | [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) | `LINEAR_API_KEY` | API key header (see note) |

> **Trello note:** The Trello API uses query parameter authentication rather than headers. Include `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` in your request URLs — the `${VAR}` placeholders are resolved automatically from the route's secrets.

> **Linear note:** Linear is a GraphQL-only API. All requests should be POST requests to `https://api.linear.app/graphql` with a JSON body containing your GraphQL query. The connection uses the `Authorization: <API_KEY>` format (no "Bearer" prefix) which is correct for Linear personal API keys. If you use OAuth tokens instead, override with a custom route that includes the "Bearer" prefix.

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

## Planned Connections

The following connections are on the roadmap to be added:

### Tier 1 — High Priority
- [ ] **Jira** — Project management (Atlassian)
- [ ] **Notion** — Docs, wikis, and project management
- [ ] **Google APIs** — Sheets, Docs, Drive, Calendar
- [ ] **HubSpot** — CRM platform
- [ ] **Twilio / SendGrid** — Messaging & email APIs

### Tier 2 — Developer & Productivity
- [ ] **GitLab** — Git hosting & CI/CD
- [ ] **Bitbucket** — Git hosting (Atlassian ecosystem)
- [ ] **Asana** — Project management
- [ ] **Confluence** — Wiki & docs (Atlassian ecosystem)
- [ ] **Discord** — Community & messaging platform
- [ ] **Datadog** — Monitoring & observability
- [ ] **PagerDuty** — Incident management

### Tier 3 — Popular SaaS & Business Tools
- [ ] **Airtable** — Spreadsheet/database hybrid
- [ ] **Shopify** — E-commerce platform
- [ ] **Intercom** — Customer support
- [ ] **Zendesk** — Customer support
- [ ] **Salesforce** — Enterprise CRM
- [ ] **Monday.com** — Project management
- [ ] **Figma** — Design platform

### Tier 4 — Infrastructure & AI
- [ ] **AWS** — S3, Lambda, etc.
- [ ] **Cloudflare** — Edge, DNS, Workers
- [ ] **OpenAI API** — LLM provider
- [ ] **Anthropic API** — LLM provider
- [ ] **OpenRouter** — Unified LLM API gateway
