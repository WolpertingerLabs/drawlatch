# Connections (Pre-built Route Templates)

Instead of manually configuring connectors for popular APIs, you can use **connections** — pre-built route templates that ship with the package. Reference them by name in a caller's `connections` list in `remote.config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "/absolute/path/to/.mcp-secure-proxy/keys/remote",
  "callers": {
    "my-laptop": {
      "peerKeyDir": "/absolute/path/to/.mcp-secure-proxy/keys/peers/my-laptop",
      "connections": ["github", "stripe"]
    }
  },
  "rateLimitPerMinute": 60
}
```

Connection templates are loaded when a caller's session is established. Custom connectors (defined in the top-level `connectors` array) with a matching `alias` take precedence over built-in templates — you can override any connection by defining a custom connector with the same alias.

## Available Connections

| Connection      | API                                                                                           | Required Environment Variable(s) | Auth Method                      |
| --------------- | --------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------- |
| `anthropic`     | [Anthropic Claude API](https://docs.anthropic.com/en/api)                                     | `ANTHROPIC_API_KEY`              | x-api-key header (see note)      |
| `bluesky`       | [Bluesky API (AT Protocol)](https://docs.bsky.app/)                                           | `BLUESKY_ACCESS_TOKEN`           | Bearer token header (see note)   |
| `devin`         | [Devin AI API](https://docs.devin.ai/api-reference/overview)                                  | `DEVIN_API_KEY`                  | Bearer token header              |
| `discord-bot`   | [Discord Bot API](https://discord.com/developers/docs/intro)                                  | `DISCORD_BOT_TOKEN`              | Bot token header (see note)      |
| `discord-oauth` | [Discord OAuth2 API](https://discord.com/developers/docs/topics/oauth2)                       | `DISCORD_OAUTH_TOKEN`            | Bearer token header (see note)   |
| `github`        | [GitHub REST API](https://docs.github.com/en/rest)                                            | `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` | Bearer token header (see note) |
| `google`        | [Google APIs](https://developers.google.com/apis-explorer)                                    | `GOOGLE_API_TOKEN`               | Bearer token header (see note)   |
| `google-ai`     | [Google AI Gemini API](https://ai.google.dev/api)                                             | `GOOGLE_AI_API_KEY`              | x-goog-api-key header (see note) |
| `hex`           | [Hex API](https://learn.hex.tech/docs/api/api-overview)                                       | `HEX_TOKEN`                      | Bearer token header              |
| `lichess`       | [Lichess API](https://lichess.org/api)                                                        | _(none)_                         | Public (no auth)                 |
| `linear`        | [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) | `LINEAR_API_KEY`                 | API key header (see note)        |
| `mastodon`      | [Mastodon API](https://docs.joinmastodon.org/api/)                                            | `MASTODON_ACCESS_TOKEN`          | Bearer token header (see note)   |
| `notion`        | [Notion API](https://developers.notion.com/reference)                                         | `NOTION_API_KEY`                 | Bearer token header (see note)   |
| `openai`        | [OpenAI API](https://platform.openai.com/docs/api-reference)                                  | `OPENAI_API_KEY`                 | Bearer token header              |
| `openrouter`    | [OpenRouter API](https://openrouter.ai/docs/api-reference)                                    | `OPENROUTER_API_KEY`             | Bearer token header              |
| `reddit`        | [Reddit API](https://www.reddit.com/dev/api/)                                                 | `REDDIT_ACCESS_TOKEN`, `REDDIT_USER_AGENT` | Bearer token header (see note) |
| `slack`         | [Slack Web API](https://docs.slack.dev/apis/web-api)                                          | `SLACK_BOT_TOKEN`                | Bearer token header              |
| `stripe`        | [Stripe Payments API](https://docs.stripe.com/api)                                            | `STRIPE_SECRET_KEY`              | Bearer token header              |
| `telegram`      | [Telegram Bot API](https://core.telegram.org/bots/api)                                        | `TELEGRAM_BOT_TOKEN`             | URL path token (see note)        |
| `trello`        | [Trello Boards API](https://developer.atlassian.com/cloud/trello/rest/)                       | `TRELLO_API_KEY`, `TRELLO_TOKEN` | Query parameters (see note)      |
| `twitch`        | [Twitch Helix API](https://dev.twitch.tv/docs/api/reference/)                                 | `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID` | Bearer + Client-Id headers (see note) |
| `x`             | [X (Twitter) API v2](https://developer.x.com/en/docs/x-api)                                  | `X_BEARER_TOKEN`                 | Bearer token header (see note)   |

> **Anthropic note:** The Anthropic API uses a custom `x-api-key` header instead of the standard `Authorization: Bearer` pattern. The `anthropic-version` header is pinned to `2023-06-01`. To use a different API version, override with a custom route.

> **GitHub note:** The `github` connection includes a **webhook ingestor** for real-time events (push, pull_request, issues, etc.). Set `GITHUB_WEBHOOK_SECRET` to the webhook signing secret configured in your GitHub repository's webhook settings, then point the webhook URL to `https://<your-server>/webhooks/github`. Events are buffered and retrievable via `poll_events`. The server must be publicly accessible (or behind a tunnel like ngrok/Cloudflare Tunnel) to receive webhook POSTs. If you don't need webhook ingestion, the `GITHUB_WEBHOOK_SECRET` env var can be left unset — the REST API functionality works independently.

> **Discord note:** Discord has two connection types. `discord-bot` uses the `Bot` authorization prefix for bot tokens, which have full access to most API routes (guilds, channels, messages, etc.). `discord-oauth` uses a standard `Bearer` token obtained via OAuth2, which provides user-scoped access limited to the authorized scopes (identity, guilds list, email, etc.). Both target the same v10 API base URL.

> **Google AI note:** The Google AI (Gemini) API uses a custom `x-goog-api-key` header instead of the standard `Authorization: Bearer` pattern. This is separate from the `google` connection — use `google` for Workspace APIs (Sheets, Drive, etc.) and `google-ai` for Gemini LLM endpoints. The endpoint is not version-pinned (`generativelanguage.googleapis.com/**`) to allow access to both `v1` and `v1beta` paths.

> **Google APIs note:** Google Workspace APIs span many subdomains (sheets.googleapis.com, drive.googleapis.com, etc.). The `google` connection allowlists the most common domains. If you need additional subdomains, add a custom route with the same `GOOGLE_API_TOKEN` secret. For Google AI / Gemini, use the `google-ai` connection instead.

> **Linear note:** Linear is a GraphQL-only API. All requests should be POST requests to `https://api.linear.app/graphql` with a JSON body containing your GraphQL query. The connection uses the `Authorization: <API_KEY>` format (no "Bearer" prefix) which is correct for Linear personal API keys. If you use OAuth tokens instead, override with a custom route that includes the "Bearer" prefix.

> **Notion note:** The Notion API requires a `Notion-Version` header. This connection pins it to `2022-06-28` (the last stable version before breaking multi-source changes). To use a newer version, override with a custom route.

> **Trello note:** The Trello API uses query parameter authentication rather than headers. Include `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` in your request URLs — the `${VAR}` placeholders are resolved automatically from the route's secrets.

> **Bluesky note:** Bluesky uses the AT Protocol. Obtain an access token by POSTing to `https://bsky.social/xrpc/com.atproto.server.createSession` with `{ "identifier": "your.handle", "password": "your-app-password" }`. Use an [App Password](https://bsky.app/settings/app-passwords) rather than your main password. Access tokens expire after ~2 hours — rotate externally using the `refreshJwt` from the session response. Both `bsky.social` (authenticated PDS) and `public.api.bsky.app` (public read-only API) are allowlisted. For self-hosted PDS instances, override with a custom connector. Rate limit: 3,000 requests per 5 minutes. The AT Protocol firehose (`wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`) provides real-time events but is not yet supported as an ingestor type.

> **Mastodon note:** This template targets the `mastodon.social` instance. Mastodon is a federated network — each instance has its own API URL. To use a different instance, define a custom connector with the same auth pattern but replace `mastodon.social` in `allowedEndpoints` with your instance domain (e.g., `hachyderm.io`, `fosstodon.org`). Obtain an access token from your instance's Development settings (Preferences > Development > New Application). Rate limit: 300 requests per 5 minutes per token (default, may vary by instance).

> **Reddit note:** The Reddit API requires a descriptive `User-Agent` header — set `REDDIT_USER_AGENT` to something like `platform:myapp:v1.0 (by /u/yourusername)`. Obtain an OAuth2 token by registering a "script" application at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps), then POSTing to `https://www.reddit.com/api/v1/access_token` with HTTP Basic Auth (`client_id:client_secret`) and `grant_type=client_credentials` (or `password` for user context). Tokens expire after 1 hour — rotate externally using the refresh token. The poll ingestor monitors a subreddit for new posts — set `REDDIT_SUBREDDIT` to the subreddit name without the `r/` prefix (e.g., `programming`). If unset, the poll will fail; disable the ingestor via `ingestorOverrides` if not needed. Rate limit: 100 requests per minute per OAuth2 token.

> **Telegram note:** The Telegram Bot API embeds the bot token in the URL path rather than in headers. Include `/bot${TELEGRAM_BOT_TOKEN}/` in your request URLs (e.g., `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`) — the `${VAR}` placeholder is resolved automatically from the route's secrets. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram to obtain a token. The poll ingestor uses `getUpdates` to fetch new messages and events. Note: if you set up a webhook externally, `getUpdates` will not work — Telegram only supports one delivery method at a time.

> **Twitch note:** Twitch requires both `Authorization: Bearer` and `Client-Id` headers on every API request. Register an application at the [Twitch Developer Console](https://dev.twitch.tv/console/apps) to get a Client ID, then obtain an access token via OAuth2 (client credentials for app tokens, or authorization code for user tokens). App tokens cannot access user-specific endpoints like followed streams — the poll ingestor requires a user access token and `TWITCH_USER_ID`. Get your user ID via `GET /helix/users` with your token. If the poll ingestor is not needed, `TWITCH_USER_ID` can be left unset. Rate limit: 800 requests per minute with a valid token.

> **X (Twitter) note:** The `x` connection uses the v2 API with an App-only Bearer token (available from the [X Developer Portal](https://developer.x.com/en/portal/dashboard)). Both `api.x.com` and `api.twitter.com` (legacy domain) are allowlisted. The poll ingestor searches recent tweets matching a configurable query — set `X_SEARCH_QUERY` to a search query string (e.g., `#programming -is:retweet`). If unset, the poll will fail; disable the ingestor via `ingestorOverrides` if not needed. API access tiers vary significantly — the Free tier allows 1 app and read-only access with low rate limits; Basic ($200/month) adds write access and higher limits. X also supports filtered streams (`GET /2/tweets/search/stream`) for real-time tweet delivery, but this requires an active HTTP streaming connection not currently supported by the poll ingestor.

> **Lichess note:** The Lichess API is public and requires no authentication for the Opening Explorer and Cloud Evaluation endpoints. Two domains are allowlisted: `explorer.lichess.ovh` for opening statistics (master games and rated Lichess games) and `lichess.org/api` for cloud engine evaluations. No environment variables needed. For player-specific analysis requiring a Lichess OAuth token, override with a custom connector.

## Example: Connections with environment variables

Set the required environment variables on the remote server (via `.env` file, shell export, or your deployment platform), then reference the connections in a caller's config:

```bash
# .env on the remote server
GITHUB_TOKEN=ghp_your_github_token_here
STRIPE_SECRET_KEY=sk_live_your_stripe_key_here
```

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

That's it — the connection templates handle endpoint patterns, auth headers, docs URLs, and OpenAPI specs automatically.

## Example: Mixing connections and custom connectors

You can use built-in connections alongside custom connectors. Custom connectors are defined in the top-level `connectors` array with an `alias`, then referenced by name in caller `connections` lists:

```json
{
  "connectors": [
    {
      "alias": "internal-api",
      "name": "Internal API",
      "allowedEndpoints": ["http://localhost:4567/**"],
      "headers": { "Authorization": "Bearer ${INTERNAL_TOKEN}" },
      "secrets": { "INTERNAL_TOKEN": "${INTERNAL_TOKEN}" }
    }
  ],
  "callers": {
    "my-laptop": {
      "peerKeyDir": "/keys/peers/my-laptop",
      "connections": ["github", "internal-api"]
    }
  }
}
```

Custom connectors with an `alias` that matches a built-in connection name take precedence over the built-in template.

## Example: Per-caller env overrides

When multiple callers share the same connection but need different credentials, use the `env` field to redirect environment variable resolution per caller:

```json
{
  "callers": {
    "alice": {
      "peerKeyDir": "/keys/peers/alice",
      "connections": ["github"],
      "env": { "GITHUB_TOKEN": "${ALICE_GITHUB_TOKEN}" }
    },
    "bob": {
      "peerKeyDir": "/keys/peers/bob",
      "connections": ["github"],
      "env": { "GITHUB_TOKEN": "${BOB_GITHUB_TOKEN}" }
    }
  }
}
```

Both callers use the same `github` built-in connection, but Alice's requests resolve `GITHUB_TOKEN` from `process.env.ALICE_GITHUB_TOKEN` while Bob's resolve from `process.env.BOB_GITHUB_TOKEN`. Values can also be literal strings for direct injection (e.g., `"STRIPE_SECRET_KEY": "sk_test_hardcoded"`).

Connection templates are stored as JSON files in `src/connections/`. You can inspect them to see exactly what headers, endpoints, and secrets each connection configures.

## Planned Connections

The following connections are on the roadmap to be added:

### Tier 1 — High Priority

- [ ] **Jira** — Project management (Atlassian)
- [ ] **HubSpot** — CRM platform
- [ ] **Twilio / SendGrid** — Messaging & email APIs
- [ ] **Microsoft Graph** — Teams, Outlook, OneDrive, SharePoint (Azure AD OAuth2)

### Tier 2 — Developer & Productivity

- [ ] **GitLab** — Git hosting & CI/CD
- [ ] **Bitbucket** — Git hosting (Atlassian ecosystem)
- [ ] **Asana** — Project management
- [ ] **Confluence** — Wiki & docs (Atlassian ecosystem)
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

### Tier 5 — Social & Content Platforms

- [ ] **YouTube Data API** — Video search, channels, playlists (API key auth, complements `google` connection)
- [ ] **LinkedIn** — Professional networking (OAuth2)
- [ ] **Pinterest** — Visual discovery (OAuth2)
- [ ] **Tumblr** — Blogging platform (OAuth2)
