# Webhook Lifecycle: Auto-Registration & Cleanup

## Problem

Webhook-based ingestors (Trello, potentially GitHub, Stripe) are passive — they listen for incoming POSTs but never register themselves with the external service. Users must manually call the external API to create a webhook pointing at the drawlatch callback URL. When using Cloudflare quick tunnels, the URL changes every restart, making manual registration fragile and tedious.

During debugging, we found that:

1. The Trello ingestor was running (state: `connected`) with 0 events received
2. Discord was working fine (5 events)
3. The tunnel was active, the callback URL was auto-set correctly
4. **The root cause: no webhook was registered with Trello's API** — `GET /1/tokens/{token}/webhooks` returned `[]`

After manually registering a webhook via `POST /1/tokens/{token}/webhooks`, events flowed through immediately.

## Proposed Solution

Add a declarative `lifecycle` config to the webhook ingestor definition in connection template JSON files. A new `WebhookLifecycleManager` class reads this config and executes HTTP requests to list, register, and unregister webhooks at the appropriate times in the ingestor lifecycle.

---

## Design Decisions

### 1. No webhook ID persistence

On every `start()`, use the `list` endpoint to discover existing webhooks by matching callback URL + model ID. This is crash-safe and handles tunnel URL changes without needing a state file.

### 2. Unregister on permanent stop only

`stop()` gets an optional `permanent` flag. Regular stop (pause/restart) does NOT unregister. Permanent stop (instance deletion, server shutdown) does unregister. This prevents losing events during brief pauses.

### 3. Graceful degradation

If auto-registration fails, log a warning and start the ingestor anyway. The user can still register manually or retry via `control_listener(restart)`.

### 4. Registration status in `ingestor_status`

Add a `webhookRegistration` field to `IngestorStatus` so callers can see if registration succeeded, failed, or hasn't been attempted.

---

## Config Shape

### `trello.json` — lifecycle added to webhook config

```json
{
  "ingestor": {
    "type": "webhook",
    "webhook": {
      "path": "trello",
      "protocol": "trello",
      "signatureHeader": "X-Trello-Webhook",
      "signatureSecret": "TRELLO_API_SECRET",
      "callbackUrl": "${TRELLO_CALLBACK_URL}",
      "lifecycle": {
        "list": {
          "method": "GET",
          "url": "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}",
          "callbackUrlField": "callbackURL",
          "idField": "id",
          "modelIdField": "idModel"
        },
        "register": {
          "method": "POST",
          "url": "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_API_KEY}",
          "headers": { "Content-Type": "application/json" },
          "body": {
            "callbackURL": "${TRELLO_CALLBACK_URL}",
            "idModel": "${boardId}",
            "description": "Drawlatch webhook"
          },
          "idField": "id"
        },
        "unregister": {
          "method": "DELETE",
          "url": "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/${_webhookId}?key=${TRELLO_API_KEY}"
        }
      }
    }
  }
}
```

All URLs and body values support `${VAR}` placeholder resolution against resolved secrets + instance params. The special `${_webhookId}` placeholder in the unregister URL is replaced at call time with the stored webhook ID.

---

## File Changes

All paths relative to drawlatch repo root.

### New Files

#### `src/remote/ingestors/webhook/lifecycle-types.ts`

Type definitions for the lifecycle config and runtime state:

```ts
/** Lifecycle configuration for a webhook ingestor. */
export interface WebhookLifecycleConfig {
  /** List existing webhooks. Used to find existing registrations and detect stale ones. */
  list?: {
    method: string;
    url: string;                    // supports ${VAR} placeholders
    headers?: Record<string, string>;
    responsePath?: string;          // dot-path to array in response (omit if top-level)
    callbackUrlField: string;       // field name containing callback URL
    idField: string;                // field name containing webhook ID
    modelIdField?: string;          // field name containing model/resource ID
  };

  /** Register a new webhook with the external service. */
  register?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;  // supports ${VAR} and ${instanceParam} placeholders
    idField: string;                 // field in response containing new webhook ID
  };

  /** Unregister (delete) a webhook from the external service. */
  unregister?: {
    method: string;
    url: string;                     // ${_webhookId} replaced at call time
    headers?: Record<string, string>;
  };
}

/** Runtime state of a webhook registration. */
export interface WebhookRegistrationState {
  registered: boolean;
  webhookId?: string;
  error?: string;
  lastAttempt?: string;             // ISO-8601
}
```

#### `src/remote/ingestors/webhook/webhook-lifecycle-manager.ts`

Stateless utility that executes lifecycle HTTP requests:

- `ensureRegistered(callbackUrl, modelId?)` — idempotent flow:
  1. Call `list` → find existing webhook matching callbackUrl + modelId → reuse if found
  2. Find stale webhooks (matching modelId but wrong callbackUrl) → `unregister` each
  3. If no match → `register` new webhook → return `{ registered: true, webhookId }`
- `unregister(webhookId)` — DELETE the webhook by ID
- `cleanupStale(callbackUrl, modelId?)` — find and remove webhooks with wrong callbackUrl

Uses raw `fetch()` directly (not proxy routes) since secrets are already resolved and the URLs may not match the connection's `allowedEndpoints` patterns.

### Modified Files

#### `src/remote/ingestors/types.ts`

- Add `lifecycle?: WebhookLifecycleConfig` to `WebhookIngestorConfig`
- Add optional `webhookRegistration` to `IngestorStatus`:
  ```ts
  webhookRegistration?: {
    registered: boolean;
    webhookId?: string;
    error?: string;
  }
  ```

#### `src/remote/ingestors/base-ingestor.ts`

- Change `abstract stop(): Promise<void>` → `abstract stop(permanent?: boolean): Promise<void>`
- Backward-compatible (optional param defaults to `false`)

#### `src/remote/ingestors/webhook/base-webhook-ingestor.ts`

The main integration point. Changes:

- **Constructor**: If `webhookConfig.lifecycle` exists, create a `WebhookLifecycleManager` with resolved secrets and instance params (from `_instanceParams` bag on the config)
- **`start()`**: Before setting state to `connected`, call `lifecycleManager.ensureRegistered(resolvedCallbackUrl, modelId)` in a try/catch. Store result in `this.registrationState`. Always proceed to `connected` even on failure.
- **`stop(permanent?)`**: If `permanent === true` and we have a stored webhookId, call `lifecycleManager.unregister(webhookId)`. Then set state to `stopped`.
- **New `getModelId()`**: Protected method returning `undefined` by default. Subclasses override for multi-instance support.
- **`getStatus()` override**: Include `webhookRegistration` from `this.registrationState`.

#### `src/remote/ingestors/webhook/trello-webhook-ingestor.ts`

- Add `getModelId()` override returning `this.boardId`
- No other changes — all lifecycle logic lives in the base class

#### `src/remote/ingestors/manager.ts`

Three changes:

**a) Collect instance params for lifecycle template resolution**

In `applyInstanceParams()`, gather all string-typed params into a `_instanceParams` bag on the webhook config so the lifecycle manager can use them for body/URL template resolution:

```ts
const instanceParams: Record<string, string> = {};
for (const [paramKey, paramValue] of Object.entries(params)) {
  if (typeof paramValue === 'string') instanceParams[paramKey] = paramValue;
}
if (config.webhook && Object.keys(instanceParams).length > 0) {
  (config.webhook as any)._instanceParams = instanceParams;
}
```

**b) Pass `permanent: true` on shutdown and deletion**

- `stopAll()`: call `ingestor.stop(true)` instead of `ingestor.stop()` (server is shutting down, tunnel URL will be invalid)
- New `deleteOne(caller, connection, instanceId)` method that calls `stopOneInstance` with `permanent=true`
- `stopOneInstance` gains optional `permanent` param, forwarded to `ingestor.stop(permanent)`

**c) Regular stop leaves webhooks intact**

- `stopOne()` and `restartOne()` continue to call `stop()` without `permanent`, so webhooks survive pause/restart cycles

#### `src/remote/server.ts`

- In the `delete_listener_instance` tool handler, call `mgr.deleteOne()` instead of `mgr.stopOne()` so the webhook gets unregistered on instance deletion

#### `src/connections/trello.json`

- Add the `lifecycle` block shown in the Config Shape section above

#### Other ingestors (interface compat)

Add the optional `permanent` param to `stop()` on all existing ingestors (unused, just for interface compatibility):

- `discord/discord-gateway.ts`
- `slack/socket-mode.ts`
- `webhook/github-webhook-ingestor.ts`
- `webhook/stripe-webhook-ingestor.ts`
- `poll/poll-ingestor.ts`

---

## Execution Flows

### Server Start (happy path)

```
1. Server starts, tunnel created
2. TRELLO_CALLBACK_URL auto-set to https://abc.trycloudflare.com/webhooks/trello
3. IngestorManager.startAll() resolves secrets (TRELLO_CALLBACK_URL now in process.env)
4. TrelloWebhookIngestor constructed with lifecycle manager
5. TrelloWebhookIngestor.start() called:
   a. lifecycleManager.ensureRegistered(callbackUrl, boardId):
      i.   GET /1/tokens/{token}/webhooks → list all
      ii.  Match by callbackUrl + idModel? → reuse existing webhook, done
      iii. Stale webhooks (wrong callbackUrl, same idModel)? → DELETE each
      iv.  No match → POST new webhook → store returned ID
   b. registrationState = { registered: true, webhookId: "xyz" }
   c. state = 'connected'
   d. log.info("Webhook auto-registered for trello (ID: xyz)")
```

### Server Restart (new tunnel URL)

Same flow as above. Step 5a-iii handles stale webhook cleanup automatically — the `list` response shows webhooks with the old tunnel URL, and `ensureRegistered` compares against the current callback URL.

### Instance Deletion

```
1. delete_listener_instance(connection="trello", instance_id="project-board")
2. mgr.deleteOne(caller, "trello", "project-board")
3. ingestor.stop(permanent=true)
4. lifecycleManager.unregister(webhookId) → DELETE /webhooks/{id}
5. Instance removed from config
```

### Graceful Degradation

| Failure | Behavior |
|---------|----------|
| `list` fails | Skip stale cleanup, attempt direct `register` |
| `register` fails | Log warning, set `registrationState.error`, proceed to `connected` |
| `unregister` fails | Log warning, continue with stop |
| No `lifecycle` config | Skip entirely (backward compatible) |

---

## Verification Plan

1. **Unit tests** for `WebhookLifecycleManager` (`webhook-lifecycle-manager.test.ts`):
   - Mock `fetch()` responses for list/register/unregister
   - Test ensureRegistered when no existing webhook (registers new)
   - Test ensureRegistered when matching webhook exists (reuses)
   - Test ensureRegistered when stale webhook exists (cleans up + registers new)
   - Test graceful degradation on HTTP failures
   - Test placeholder resolution in URLs and bodies

2. **Integration tests** for base-webhook-ingestor lifecycle:
   - `start()` calls lifecycle when config present
   - `start()` proceeds even if lifecycle fails
   - `stop(false)` does NOT unregister
   - `stop(true)` does unregister
   - `getStatus()` includes registration state

3. **Manager tests**:
   - `stopAll` passes `permanent=true`
   - `deleteOne` passes `permanent=true`
   - `_instanceParams` bag populated correctly

4. **Manual E2E**:
   - Start drawlatch with `--tunnel`, confirm Trello webhook auto-registers
   - Create a card on the board, verify event arrives via `poll_events`
   - Restart drawlatch (new tunnel URL), confirm old webhook cleaned up and new one registered
   - Delete the instance, confirm webhook unregistered from Trello

5. **Regression**: `npm run build` and `npm test` pass

---

## Future Extensions

- **GitHub webhook lifecycle**: GitHub allows programmatic webhook creation via `POST /repos/{owner}/{repo}/hooks`. Add lifecycle config to `github.json`.
- **Stripe webhook lifecycle**: Stripe supports `POST /v1/webhook_endpoints`. Same declarative pattern.
- **Webhook health monitoring**: Periodically call `list` to check if the webhook is still active and has low `consecutiveFailures`.
- **Callboard UI**: Show webhook registration status badge in the listener management panel (the `webhookRegistration` field on `IngestorStatus` enables this with no additional drawlatch changes).
