# Plan: Spotify support + generic OAuth2 token refresh

Status: **Approved (Ben, 2026-06-22).** Scope = generic refresh capability with Spotify as
first consumer; access = both user-scoped and public-catalog. Author: Forge.

## Architecture decision

drawlatch connection templates are pure declarative JSON (`src/connections/{category}/{alias}.json`),
auto-discovered, no registry edit, no code. Adding a *static-token* Spotify template would be a
one-file change — but **Spotify user access tokens expire in 1 hour**, and drawlatch today has
**zero token-refresh machinery**. Every existing OAuth2 connection (`reddit`, `twitch`,
`discord-oauth`, `bluesky`) injects a static env-var Bearer token and tells the user to "rotate
externally" — `executeProxyRequest` (`src/remote/tool-dispatch.ts`) and the poll ingestor
(`src/remote/ingestors/poll/poll-ingestor.ts`) both do a single static-header `fetch`, with no
expiry check, refresh, or retry-with-new-token.

So this is not "add a JSON file." We are giving drawlatch a **first-class, generic OAuth2 refresh
capability**, declared per-template, owned by the daemon (which already is the secret boundary).
Spotify is the first consumer; `reddit`/`twitch`/`bluesky`/`discord-oauth` can retrofit onto it
later. The capability is intentionally generic — no Spotify-specific code in the engine.

**Two templates, one engine** (mirrors the existing `discord-bot` / `discord-oauth` split):

- **`spotify`** (social-media) — user-scoped, authorization-code + `refresh_token` grant.
  Playback, library, playlists, recently-played, top tracks.
- **`spotify-catalog`** (social-media) — `client_credentials` grant. Search + public
  track/album/artist metadata, no user consent.

### Spotify token endpoint contract (the gotcha)

`POST https://accounts.spotify.com/api/token`, `Content-Type: application/x-www-form-urlencoded`
(NOT JSON), `Authorization: Basic base64(client_id:client_secret)`. The `refresh_token` grant
returns `{access_token, expires_in, scope, token_type}` and **may or may not** include a new
`refresh_token` (Spotify usually does not rotate — the engine must handle both). Card 0 pins this
down for real before any engine code is written.

## Work items

Cards 1→4 are sequential; each depends on the prior. **Card 0 (spike) gates the lot** — its
findings inform the Card 1/2 schema and TokenManager design. Card 5 is independent follow-up.
TDD throughout; branch + PR per card; Forge reviews, Ben merges.

### Card 0 — Spike: Spotify OAuth flows (de-risks everything)

Hit Spotify for real, outside drawlatch. Confirm the token-endpoint request/response shapes
above for **both** the `refresh_token` grant and the `client_credentials` grant. Explicitly
verify whether a rotated `refresh_token` ever comes back. Deliverable: documented contracts
appended to this plan, enough to lock the Card 1 schema and Card 2 TokenManager design. No
production code.

### Card 1 — `oauth2` template block + schema/validation (`src/shared/`)

Add an optional `oauth2` block to the `Route` interface:

```
oauth2?: {
  tokenUrl: string;
  grant: 'refresh_token' | 'client_credentials';
  clientAuth: 'basic' | 'body';            // how client_id/secret are sent
  secretRefs: {                            // names of secrets, not values
    clientId: string;
    clientSecret: string;
    refreshToken?: string;                 // required iff grant === 'refresh_token'
  };
  responseMapping?: {                      // defaults: access_token / expires_in / refresh_token
    accessTokenField?: string;
    expiresInField?: string;
    refreshTokenField?: string;
  };
  scopes?: string[];                       // for client_credentials body
  refreshSkewMs?: number;                  // default ~60_000
};
```

Extend `src/shared/connections.test.ts`: oauth2 templates must declare `grant` + `tokenUrl`; the
`refresh_token` grant must declare a `refreshToken` secretRef; required secrets are surfaced via
the existing `listConnectionTemplates()` introspection.

### Card 2 — `TokenManager` core (`src/remote/oauth/token-manager.ts`)

In-memory token cache keyed by **(connection, caller)**. `getAccessToken()` returns the cached
token if still valid (now + skew < expiry), else refreshes. **Single-flight**: a per-key
in-flight refresh promise so concurrent requests share one token-endpoint call (no stampede).
Form-encoded body + `Basic`/body client auth per `clientAuth`. Handles both grants; persists a
rotated refresh token in-memory if one is returned. **Secret-boundary invariants (hard):** access
tokens and client secrets are never logged, never serialized into any response, memory-only
(re-derived from the refresh token on restart). Unit tests with mocked `fetch` covering: cache
hit, expiry refresh, single-flight coalescing, rotated-refresh-token, token-endpoint error.

### Card 3 — Wire into request paths

`executeProxyRequest` (`src/remote/tool-dispatch.ts`): when the matched route has an `oauth2`
block, resolve the `Authorization: Bearer` value via `TokenManager.getAccessToken(connection,
caller)` instead of a static `${TOKEN}` placeholder. On a `401` from an oauth2 route, force exactly
one refresh + single retry (no loop). Mirror the same wiring in
`src/remote/ingestors/poll/poll-ingestor.ts` so ingestors survive the 1h expiry. Tests for both
paths incl. the 401→refresh→retry path and the no-loop guarantee.

### Card 4 — Spotify templates + docs

- `src/connections/social-media/spotify.json` — `oauth2` refresh_token grant; allowlist
  `https://api.spotify.com/**`; `testConnection` `GET /v1/me`; recently-played poll ingestor
  (`/v1/me/player/recently-played`) + `testIngestor` + `listenerConfig`. Secrets:
  `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`.
- `src/connections/social-media/spotify-catalog.json` — `oauth2` client_credentials grant; same
  allowlist; `testConnection` a minimal catalog search. Secrets: `SPOTIFY_CLIENT_ID`,
  `SPOTIFY_CLIENT_SECRET`.
- Update `CONNECTIONS.md` with both rows (alias, API link, env vars, auth method).

### Card 5 — (optional follow-up, not blocking)

Retrofit `reddit` / `twitch` / `bluesky` / `discord-oauth` onto the refresh engine where a refresh
token is available, replacing the "rotate externally" static-token pattern.

## Card 0 findings (spike complete, 2026-06-22 — confirmed vs developer.spotify.com)

**Token endpoint** `POST https://accounts.spotify.com/api/token`, `Content-Type:
application/x-www-form-urlencoded` (never JSON), client auth via `Authorization: Basic
base64(client_id:client_secret)` for **both** grants. `expires_in` = **3600s** for all flows →
refresh proactively (~3300s / skew ≥ 300s).

- **refresh_token grant** body: `grant_type=refresh_token` + `refresh_token=<token>` (client_id
  in body only for PKCE — not us; we use the Basic header). Response:
  `{access_token, token_type:"Bearer", expires_in, scope, refresh_token?}`.
- **client_credentials grant** body: `grant_type=client_credentials` only. Response:
  `{access_token, token_type:"bearer", expires_in}` — no scope, no refresh_token.
- **Rotation (load-bearing for Card 2):** the refresh response *may or may not* include a new
  `refresh_token` — docs: *"When a refresh token is not returned, continue using the existing
  token."* TokenManager MUST persist a rotated refresh token when present, keep the old one when
  absent. Do not assume the original is immortal.
- **Dead-token detection:** `400 {error:"invalid_grant"}` = expired/revoked/invalid refresh token
  → terminal "needs re-auth", surface it, do NOT retry. (Distinct from transient 5xx.)
- **Two cache entries per client:** app token (client_credentials, no refresh) and user token
  (authorization_code → refresh_token) are separate keys.

**Provisioning checklist (one-time, Ben — blocks end-to-end testing of Cards 2–4, not the build):**
1. Register an app at the Spotify Developer Dashboard → `client_id` + `client_secret`. Note the
   app's quota mode (Development vs Extended — see catalog caveat).
2. Register an **exact** redirect URI. `localhost` is NOT allowed; use loopback literal
   `http://127.0.0.1:8080/callback`. HTTPS required except loopback.
3. Mint the initial refresh token via the authorization-code flow: `GET
   https://accounts.spotify.com/authorize?client_id=…&response_type=code&redirect_uri=…&scope=…&state=…`
   → exchange the returned `code` at the token endpoint (`grant_type=authorization_code`, `code`,
   `redirect_uri`, Basic header). Persist the returned `refresh_token` as `SPOTIFY_REFRESH_TOKEN`.
4. Scopes for the `spotify` template: `user-read-playback-state user-modify-playback-state
   user-read-currently-playing user-library-read playlist-read-private
   playlist-read-collaborative user-read-recently-played user-top-read
   user-read-playback-position`.
5. `spotify-catalog` (client_credentials) needs none of steps 2–4 — just client_id/secret.

**⚠️ Feb-2026 catalog caveat (changes Card 4's `spotify-catalog` scope):** the Feb 2026 Web API
update **removed the batch catalog endpoints** (`GET /tracks`,`/albums`,`/artists`,`/episodes`,
`/shows`,`/audiobooks` "Get Several …"), removed browse endpoints, cut `/search` `limit` max
50→10, and dropped `popularity`/`available_markets`/`followers` fields — **for Development-Mode
apps**. Extended-Quota apps: no migration. Single-item fetches (`GET /tracks/{id}` etc.) and
`/search` still work with an app token. → Card 4 must scope `spotify-catalog`'s allowlist/test to
single-item + search, and the choice depends on Ben's app quota mode. Refs:
web-api/references/changes/february-2026, tutorials/february-2026-migration-guide.

**Auth split confirmed:** `/v1/search` + single-item catalog work with the app token; all
`/v1/me/*` (player, playlists, tracks, top, recently-played) require the user token.
