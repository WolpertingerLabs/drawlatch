# Connections (Pre-built Route Templates)

Instead of manually configuring connectors for popular APIs, you can use **connections** — pre-built route templates that ship with the package. Reference them by name in a caller's `connections` list in `remote.config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "callers": {
    "my-laptop": {
      "connections": ["github", "stripe"]
    }
  },
  "rateLimitPerMinute": 60
}
```

Connection templates are loaded when a caller's session is established. Custom connectors (defined in the top-level `connectors` array) with a matching `alias` take precedence over built-in templates — you can override any connection by defining a custom connector with the same alias.

## Available Connections

| Connection      | API                                                                                           | Required Environment Variable(s)           | Auth Method                           |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| `agentmail`     | [AgentMail API](https://docs.agentmail.to/api-reference)                                      | `AGENTMAIL_API_KEY`                        | Bearer token header (see note)        |
| `anthropic`     | [Anthropic Claude API](https://docs.anthropic.com/en/api)                                     | `ANTHROPIC_API_KEY`                        | x-api-key header (see note)           |
| `bluesky`       | [Bluesky API (AT Protocol)](https://docs.bsky.app/)                                           | `BLUESKY_ACCESS_TOKEN`                     | Bearer token header (see note)        |
| `datadog`       | [Datadog API](https://docs.datadoghq.com/api/latest/)                                         | `DATADOG_API_KEY`, `DATADOG_APP_KEY`       | DD-API-KEY + DD-APPLICATION-KEY headers (see note) |
| `devin`         | [Devin AI API](https://docs.devin.ai/api-reference/overview)                                  | `DEVIN_API_KEY`                            | Bearer token header                   |
| `discord-bot`   | [Discord Bot API](https://discord.com/developers/docs/intro)                                  | `DISCORD_BOT_TOKEN`                        | Bot token header (see note)           |
| `discord-oauth` | [Discord OAuth2 API](https://discord.com/developers/docs/topics/oauth2)                       | `DISCORD_OAUTH_TOKEN`                      | Bearer token header (see note)        |
| `exa`           | [Exa Search API](https://exa.ai/docs/reference/getting-started)                               | `EXA_API_KEY`                              | x-api-key header (see note)           |
| `firecrawl`     | [Firecrawl API](https://docs.firecrawl.dev/api-reference/introduction)                        | `FIRECRAWL_API_KEY`                        | Bearer token header (see note)        |
| `github`        | [GitHub REST API](https://docs.github.com/en/rest)                                            | `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`    | Bearer token header (see note)        |
| `google`        | [Google APIs](https://developers.google.com/apis-explorer)                                    | `GOOGLE_API_TOKEN`                         | Bearer token header (see note)        |
| `google-ai`     | [Google AI Gemini API](https://ai.google.dev/api)                                             | `GOOGLE_AI_API_KEY`                        | x-goog-api-key header (see note)      |
| `hex`           | [Hex API](https://learn.hex.tech/docs/api/api-overview)                                       | `HEX_TOKEN`                                | Bearer token header                   |
| `lichess`       | [Lichess API](https://lichess.org/api)                                                        | `LICHESS_API_TOKEN`                        | Bearer token header (see note)        |
| `linear`        | [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api) | `LINEAR_API_KEY`                           | API key header (see note)             |
| `mastodon`      | [Mastodon API](https://docs.joinmastodon.org/api/)                                            | `MASTODON_ACCESS_TOKEN`                    | Bearer token header (see note)        |
| `notion`        | [Notion API](https://developers.notion.com/reference)                                         | `NOTION_API_KEY`                           | Bearer token header (see note)        |
| `openai`        | [OpenAI API](https://platform.openai.com/docs/api-reference)                                  | `OPENAI_API_KEY`                           | Bearer token header                   |
| `openrouter`    | [OpenRouter API](https://openrouter.ai/docs/api-reference)                                    | `OPENROUTER_API_KEY`                       | Bearer token header                   |
| `parallel`      | [Parallel API](https://docs.parallel.ai/api-reference/search/search)                          | `PARALLEL_API_KEY`                         | x-api-key header (see note)           |
| `perplexity`    | [Perplexity API](https://docs.perplexity.ai/api-reference)                                    | `PERPLEXITY_API_KEY`                       | Bearer token header (see note)        |
| `reddit`        | [Reddit API](https://www.reddit.com/dev/api/)                                                 | `REDDIT_ACCESS_TOKEN`, `REDDIT_USER_AGENT` | Bearer token header (see note)        |
| `slack`         | [Slack Web API](https://docs.slack.dev/apis/web-api)                                          | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`       | Bearer token header (see note)        |
| `stripe`        | [Stripe Payments API](https://docs.stripe.com/api)                                            | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Bearer token header (see note)      |
| `telegram`      | [Telegram Bot API](https://core.telegram.org/bots/api)                                        | `TELEGRAM_BOT_TOKEN`                       | URL path token (see note)             |
| `trello`        | [Trello Boards API](https://developer.atlassian.com/cloud/trello/rest/)                       | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_API_SECRET`, `TRELLO_CALLBACK_URL` | Query parameters (see note) |
| `twitch`        | [Twitch Helix API](https://dev.twitch.tv/docs/api/reference/)                                 | `TWITCH_ACCESS_TOKEN`, `TWITCH_CLIENT_ID`  | Bearer + Client-Id headers (see note) |
| `x`             | [X (Twitter) API v2](https://developer.x.com/en/docs/x-api)                                   | `X_BEARER_TOKEN`                           | Bearer token header (see note)        |

> **AgentMail note:** AgentMail provides email infrastructure for AI agents (inboxes, messages, threads, drafts). All endpoints live under the `/v0` path on `api.agentmail.to` and use a standard `Authorization: Bearer ${AGENTMAIL_API_KEY}` header. Create an API key in the [AgentMail Console](https://console.agentmail.to). AgentMail can deliver inbound email in real time via Svix-signed webhooks, but that is not yet wired up as a drawlatch ingestor — this connection currently covers the REST API only.

> **Anthropic note:** The Anthropic API uses a custom `x-api-key` header instead of the standard `Authorization: Bearer` pattern. The `anthropic-version` header is pinned to `2023-06-01`. To use a different API version, override with a custom route.

> **GitHub note:** The `github` connection includes a **webhook ingestor** for real-time events (push, pull_request, issues, etc.). Set `GITHUB_WEBHOOK_SECRET` to the webhook signing secret configured in your GitHub repository's webhook settings, then point the webhook URL to `https://<your-server>/webhooks/github`. Events are buffered and retrievable via `poll_events`. The server must be publicly accessible (or behind a tunnel like ngrok/Cloudflare Tunnel) to receive webhook POSTs. If you don't need webhook ingestion, the `GITHUB_WEBHOOK_SECRET` env var can be left unset — the REST API functionality works independently.

> **Datadog note:** Datadog uses two custom auth headers instead of the standard `Authorization: Bearer` pattern: `DD-API-KEY` (an [API key](https://docs.datadoghq.com/account_management/api-app-keys/#api-keys), identifies your organization) and `DD-APPLICATION-KEY` (an [application key](https://docs.datadoghq.com/account_management/api-app-keys/#application-keys), scoped to a user's permissions). Most management endpoints (monitors, dashboards, logs search, etc.) require both; intake endpoints like metric submission need only the API key. Both v1 and v2 API paths are available under `/api`. The template targets the US1 site (`api.datadoghq.com`) by default and also allowlists the other regional sites (`api.us3.datadoghq.com`, `api.us5.datadoghq.com`, `api.datadoghq.eu`, `api.ap1.datadoghq.com`) — just use your site's base URL in request URLs. Note that the built-in connection test validates against US1 only; for other sites, verify with a direct request to `https://<your-site>/api/v1/validate`.

> **Discord note:** Discord has two connection types. `discord-bot` uses the `Bot` authorization prefix for bot tokens, which have full access to most API routes (guilds, channels, messages, etc.). `discord-oauth` uses a standard `Bearer` token obtained via OAuth2, which provides user-scoped access limited to the authorized scopes (identity, guilds list, email, etc.). Both target the same v10 API base URL.

### Web search & fetch connections

`exa`, `firecrawl`, `parallel`, and `perplexity` form the **Web Search & Fetch** category — they all turn a query or a URL into clean, LLM-ready text, but they specialize differently:

| Connection   | Best at                                                            | Pricing model                                |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| `exa`        | Neural/semantic search over the web; find-similar; sourced answers  | Per search + per page of contents            |
| `firecrawl`  | Scraping and crawling specific sites into markdown; structured extract | Per credit (roughly per page scraped)     |
| `parallel`   | Agent-shaped research: objective-driven search, async research tasks | Per search (varies by mode) + per task run   |
| `perplexity` | Cited, synthesized answers over live web results                    | Per request + per token                      |

> **Shared caveat — timeouts.** Deep operations on these APIs (Perplexity's `sonar-deep-research`, Parallel task runs, Firecrawl crawls, Exa `deep-reasoning` searches) routinely take longer than the 25s default outbound deadline, so these four connections carry a raised per-connection `requestTimeoutMs`: `exa`, `firecrawl`, and `parallel` 120s, `perplexity` 180s. That value is both the connection's default and the ceiling on what a single call may request via `secure_request`'s `timeoutMs`.
>
> Two things to know. First, a request that exceeds its deadline is **cancelled at the socket** — the upstream call stops rather than running on (and billing) with its result discarded. Second, the nested deadlines are ordered innermost-first out of the box, so the shipped `requestTimeout` (185s) no longer cuts most of these ceilings short — but one outer limit can still bind. **The MCP client's own 60s cap** applies to all four (every ceiling above is larger than 60s), so using any of them in full requires raising `MCP_TOOL_TIMEOUT` in your MCP client. Every shipped ceiling does fit under the default budget, so `requestTimeout` itself needs no adjustment. The clamp is never silent: call `list_routes` to see each connection's `defaultTimeoutMs` and `maxTimeoutMs` under the budget currently in force, and a clamped timeout error names the value to raise. For anything genuinely long-running, prefer each API's async pattern: submit a job, then poll its status endpoint. See README → Proxy Config → Request timeouts.

> **Exa note:** The Exa Search API uses a custom `x-api-key` header instead of the standard `Authorization: Bearer` pattern (Exa also accepts `Authorization: Bearer`, but this template uses `x-api-key`). The main endpoints on `https://api.exa.ai` are `POST /search` (neural or keyword web search), `POST /contents` (cleaned page text, highlights, and summaries), `POST /findSimilar` (semantically similar pages), `POST /answer` (a sourced answer to a question), and `POST /context` (code snippets from open-source repos). `POST /responses` and `POST /chat/completions` are OpenAI-compatible surfaces. Longer research runs go through the **Agent API** — `POST /agent/runs`, then `GET /agent/runs/{id}`. Monitors (`/monitors`) schedule recurring searches, and the Websets API (`/websets/v0/*`) builds verified, enriched result sets; both use GET/PATCH/DELETE as well as POST, so this is not a POST-only API. On `/search`, the `type` parameter is the primary quality/latency/cost dial: `instant`, `fast`, `auto`, `deep-lite`, `deep`, `deep-reasoning`. **`/research/v1` is retired** — it now returns `410` with a `RESEARCH_RETIRED` tag; use `/search` with `type: "deep-reasoning"` or the Agent API instead. Because `deep-reasoning` alone runs 12–40s before any `outputSchema` synthesis or livecrawl, this connection's `requestTimeoutMs` is 120s. Create an API key in the [Exa Dashboard](https://dashboard.exa.ai/api-keys). Note that the built-in connection test issues a real one-result search, so it consumes a small amount of credit.

> **Firecrawl note:** The template targets Firecrawl's **v2** API on `https://api.firecrawl.dev`. Single-shot endpoints are `POST /v2/scrape` (one page → markdown/JSON), `POST /v2/search` (web search returning full page content), and `POST /v2/map` (list a site's URLs). Long-running work is async: `POST /v2/crawl`, `POST /v2/batch/scrape`, and `POST /v2/extract` return a job id you poll via the matching `GET /v2/crawl/{id}`, `GET /v2/batch/scrape/{id}`, or `GET /v2/extract/{id}`. Also available: `POST /v2/agent` (autonomous browsing tasks), `POST /v2/parse` (documents such as PDFs → markdown), and `/v2/monitor/*` (scheduled recurring crawls). Get an API key (`fc-...`) at [firecrawl.dev](https://www.firecrawl.dev/app/api-keys). Firecrawl can also deliver crawl progress via webhooks, but that is not wired up as a drawlatch ingestor — this connection covers the REST API only. **Self-hosted Firecrawl** instances use a different base URL; define a custom connector with the same Bearer auth and your own host in `allowedEndpoints`.
>
> Two deliberate decisions worth knowing about. **The allowlist has no method dimension.** `https://api.firecrawl.dev/**` grants every verb on every path, so the key also permits `PUT /v2/team/threat-protection`, `DELETE /v2/crawl/{id}`, `DELETE /v2/monitor/{id}`, and billing reads. That is accepted as the cost of a single simple pattern; narrow `allowedEndpoints` in a custom connector if your agent should not have it. **Screenshots come back as public Supabase URLs** on a different host, which the allowlist correctly rejects — fetch those out-of-band rather than through the proxy, so your Firecrawl key is never sent to them. Finally, Firecrawl's own per-request `timeout` field documents a maximum of 300000ms, but drawlatch caps this connection at 120000ms. That is well above Firecrawl's own 30s scrape and 60s search defaults and covers realistic synchronous work; because `requestTimeoutMs` is also the connection's *default* deadline, a higher value would mean a hung scrape holds a socket for minutes. Use the async crawl/batch pattern beyond that. (Note that 300s would not be reachable end-to-end regardless — drawlatch's global outbound maximum sits below undici's 300s internal limit.)

> **Parallel note:** [Parallel Web Systems](https://parallel.ai) uses a custom `x-api-key` header. `POST /v1/search` is the main entry point — it takes `search_queries` (required, 3–6 word keyword queries) plus an optional natural-language `objective`, and a `mode` of `turbo`, `fast`, `basic`, or `advanced` (cost and latency rise in that order). **`mode` defaults to `advanced` when omitted** — the slowest and priciest preset (~3s, ~$5/1k) — so pass `turbo` (~250ms, ~$1/1k) explicitly unless you need the extra quality. `POST /v1/extract` returns full or excerpted content for a list of URLs; it is **GA at `/v1/extract`**, not `/v1beta/extract`. The Task API (`POST /v1/tasks/runs` → `GET /v1/tasks/runs/{run_id}` → `GET /v1/tasks/runs/{run_id}/result`) runs async research that returns structured JSON with citations and confidence scores; note that `POST /v1/tasks/runs` answers **202 Accepted**, not 200, so treat 202 as success rather than an error.
>
> The optional `parallel-beta` header gates specific opt-in features and is **never required** — it is `required: false` on every path in Parallel's OpenAPI spec, is accepted on GA paths such as `/v1/tasks/runs` and `/v1/tasks/runs/{run_id}/result`, and is marked deprecated on the `/v1beta/findall/*` paths. It is therefore not a "beta endpoints need this" header. The template deliberately does *not* inject it, so pass it per-request when a feature calls for one; a route-level header would be rejected as a conflict if you also sent your own. The built-in connection test issues a real turbo-mode search, so it consumes a small amount of credit.

> **Perplexity note:** One key (`pplx-...`, from [Perplexity API settings](https://www.perplexity.ai/account/api)) covers several distinct APIs on `https://api.perplexity.ai`. Perplexity's own docs position the **Agent API** (`POST /v1/agent`) as the default for web-grounded, multi-provider applications, so start there. `POST /search` returns raw ranked web results with page contents and no LLM synthesis — use it when you want sources to feed your own model. For Sonar chat completions the canonical path is `POST /v1/sonar`; `POST /chat/completions` is an **alias kept for OpenAI SDK compatibility**, not a separate API. `POST /v1/async/sonar` runs long-running research jobs polled via `GET /v1/async/sonar/{request_id}`. Embeddings are at `POST /v1/embeddings` — the `/v1/` prefix is required, `POST /embeddings` returns 404. The connection test hits `GET /v1/async/sonar`, which is authenticated and free.
>
> ⚠️ **Revisit before 2026-09-27.** Perplexity has announced that Sonar is supported only until **September 27, 2026**. That date removes both `POST /chat/completions` and the `GET /v1/async/sonar` endpoint this connection's `testConnection` uses, so the built-in test will start failing then. Both are correct today and are being kept deliberately: there is no clean free replacement (`/v1/agent/{id}/files` needs an existing id, and `GET /v1/models` is documented as `security: []` but in practice returns 401, so spec and behavior disagree and it is not a safe basis for a credential check). Migrate the test to an Agent API surface before that date.

> **Google AI note:** The Google AI (Gemini) API uses a custom `x-goog-api-key` header instead of the standard `Authorization: Bearer` pattern. This is separate from the `google` connection — use `google` for Workspace APIs (Sheets, Drive, etc.) and `google-ai` for Gemini LLM endpoints. The endpoint is not version-pinned (`generativelanguage.googleapis.com/**`) to allow access to both `v1` and `v1beta` paths.

> **Google APIs note:** Google Workspace APIs span many subdomains (sheets.googleapis.com, drive.googleapis.com, etc.). The `google` connection allowlists the most common domains. If you need additional subdomains, add a custom route with the same `GOOGLE_API_TOKEN` secret. For Google AI / Gemini, use the `google-ai` connection instead.

> **Linear note:** Linear is a GraphQL-only API. All requests should be POST requests to `https://api.linear.app/graphql` with a JSON body containing your GraphQL query. The connection uses the `Authorization: <API_KEY>` format (no "Bearer" prefix) which is correct for Linear personal API keys. If you use OAuth tokens instead, override with a custom route that includes the "Bearer" prefix.

> **Notion note:** The Notion API requires a `Notion-Version` header. This connection pins it to `2022-06-28` (the last stable version before breaking multi-source changes). To use a newer version, override with a custom route.

> **Slack note:** The `slack` connection uses `SLACK_BOT_TOKEN` (starts with `xoxb-`) for API requests. For real-time events via Socket Mode, also set `SLACK_APP_TOKEN` (starts with `xapp-`) — an App-Level Token with `connections:write` scope, generated from your app's settings in the [Slack API dashboard](https://api.slack.com/apps). Socket Mode must be enabled in the app settings. If you don't need real-time event ingestion, `SLACK_APP_TOKEN` can be left unset — the Web API functionality works independently.

> **Stripe note:** The `stripe` connection includes a **webhook ingestor** for real-time payment events (charges, invoices, subscriptions, etc.). Set `STRIPE_WEBHOOK_SECRET` to the `whsec_...` signing secret from Stripe Dashboard → Developers → Webhooks, then point the webhook URL to `https://<your-server>/webhooks/stripe`. Stripe signature verification includes replay protection with a 5-minute timestamp tolerance. If you don't need webhook ingestion, `STRIPE_WEBHOOK_SECRET` can be left unset — the API functionality works independently.

> **Trello note:** The Trello API uses query parameter authentication rather than headers. Include `?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` in your request URLs — the `${VAR}` placeholders are resolved automatically from the route's secrets. The Trello connection includes a **webhook ingestor** for real-time events (card updates, list changes, board activity). Set `TRELLO_API_SECRET` and `TRELLO_CALLBACK_URL`, then point the Trello webhook to `https://<your-server>/webhooks/trello`. Trello uses HMAC-SHA1 signature verification with a unique scheme that includes the callback URL in the HMAC computation. If you don't need webhook ingestion, `TRELLO_API_SECRET` and `TRELLO_CALLBACK_URL` can be left unset.

> **Bluesky note:** Bluesky uses the AT Protocol. Obtain an access token by POSTing to `https://bsky.social/xrpc/com.atproto.server.createSession` with `{ "identifier": "your.handle", "password": "your-app-password" }`. Use an [App Password](https://bsky.app/settings/app-passwords) rather than your main password. Access tokens expire after ~2 hours — rotate externally using the `refreshJwt` from the session response. Both `bsky.social` (authenticated PDS) and `public.api.bsky.app` (public read-only API) are allowlisted. For self-hosted PDS instances, override with a custom connector. Rate limit: 3,000 requests per 5 minutes. The AT Protocol firehose (`wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`) provides real-time events but is not yet supported as an ingestor type.

> **Mastodon note:** This template targets the `mastodon.social` instance. Mastodon is a federated network — each instance has its own API URL. To use a different instance, define a custom connector with the same auth pattern but replace `mastodon.social` in `allowedEndpoints` with your instance domain (e.g., `hachyderm.io`, `fosstodon.org`). Obtain an access token from your instance's Development settings (Preferences > Development > New Application). Rate limit: 300 requests per 5 minutes per token (default, may vary by instance).

> **Reddit note:** The Reddit API requires a descriptive `User-Agent` header — set `REDDIT_USER_AGENT` to something like `platform:myapp:v1.0 (by /u/yourusername)`. Obtain an OAuth2 token by registering a "script" application at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps), then POSTing to `https://www.reddit.com/api/v1/access_token` with HTTP Basic Auth (`client_id:client_secret`) and `grant_type=client_credentials` (or `password` for user context). Tokens expire after 1 hour — rotate externally using the refresh token. The poll ingestor monitors a subreddit for new posts — set `REDDIT_SUBREDDIT` to the subreddit name without the `r/` prefix (e.g., `programming`). If unset, the poll will fail; disable the ingestor via `ingestorOverrides` if not needed. Rate limit: 100 requests per minute per OAuth2 token.

> **Telegram note:** The Telegram Bot API embeds the bot token in the URL path rather than in headers. Include `/bot${TELEGRAM_BOT_TOKEN}/` in your request URLs (e.g., `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`) — the `${VAR}` placeholder is resolved automatically from the route's secrets. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram to obtain a token. The poll ingestor uses `getUpdates` to fetch new messages and events. Note: if you set up a webhook externally, `getUpdates` will not work — Telegram only supports one delivery method at a time.

> **Twitch note:** Twitch requires both `Authorization: Bearer` and `Client-Id` headers on every API request. Register an application at the [Twitch Developer Console](https://dev.twitch.tv/console/apps) to get a Client ID, then obtain an access token via OAuth2 (client credentials for app tokens, or authorization code for user tokens). App tokens cannot access user-specific endpoints like followed streams — the poll ingestor requires a user access token and `TWITCH_USER_ID`. Get your user ID via `GET /helix/users` with your token. If the poll ingestor is not needed, `TWITCH_USER_ID` can be left unset. Rate limit: 800 requests per minute with a valid token.

> **X (Twitter) note:** The `x` connection uses the v2 API with an App-only Bearer token (available from the [X Developer Portal](https://developer.x.com/en/portal/dashboard)). Both `api.x.com` and `api.twitter.com` (legacy domain) are allowlisted. The poll ingestor searches recent tweets matching a configurable query — set `X_SEARCH_QUERY` to a search query string (e.g., `#programming -is:retweet`). If unset, the poll will fail; disable the ingestor via `ingestorOverrides` if not needed. API access tiers vary significantly — the Free tier allows 1 app and read-only access with low rate limits; Basic ($200/month) adds write access and higher limits. X also supports filtered streams (`GET /2/tweets/search/stream`) for real-time tweet delivery, but this requires an active HTTP streaming connection not currently supported by the poll ingestor.

> **Lichess note:** The Lichess API supports both public and authenticated endpoints. Public endpoints (Opening Explorer on `explorer.lichess.ovh`, Cloud Eval on `lichess.org/api/cloud-eval`) work without a token. For authenticated routes (account info, game history, player-specific opening analysis, challenges, etc.), set `LICHESS_API_TOKEN` to a [personal API access token](https://lichess.org/account/oauth/token). The token is sent as a Bearer header on all requests — public endpoints simply ignore it. Two domains are allowlisted: `explorer.lichess.ovh` for opening statistics and `lichess.org/api` for everything else.

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
      "connections": ["github"],
      "env": { "GITHUB_TOKEN": "${ALICE_GITHUB_TOKEN}" }
    },
    "bob": {
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
