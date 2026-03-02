# Drawlatch Parity Fixes

Issues discovered during callboard integration audit (2026-03-01).
These are changes needed in drawlatch to support full local/remote feature parity.

---

## 1. `set_listener_params` should restart affected ingestors after saving

**File:** `src/remote/server.ts` — `set_listener_params` handler (line 809)

**Current behavior:** Saves config to disk via `saveRemoteConfig(config)` and returns success, but does NOT restart any ingestors. The caller must separately call `control_listener` with `action: 'restart'` to apply the new params.

**Problem:** Callboard's local-proxy calls `await this.reinitialize()` after saving (which stops all ingestors and restarts them with the updated config). This means:

- **Local mode:** Params save + ingestors auto-restart. Changes take effect immediately.
- **Remote mode:** Params save but ingestors keep running with stale params until manually restarted.

The UI's save handler (`handleSave` in `ListenerConfigPanel`) only calls `set_listener_params` — it does not follow up with `control_listener restart`. So in remote mode, saved params never take effect until the user manually restarts.

**Fix options (pick one):**

- **Option A (recommended):** After `saveRemoteConfig(config)`, call `context.ingestorManager.restartOne(callerAlias, connection, instance_id)` to restart just the affected ingestor (or all instances of the connection for single-instance changes). This is more surgical than a full reinitialize.
- **Option B:** Return a hint in the response (e.g., `restart_required: true`) so callers know to issue a follow-up `control_listener restart`.

**Note:** `delete_listener_instance` already calls `mgr.stopOne()` (line 928), so it has partial lifecycle management. `set_listener_params` should do the same for restarts.

---

## 2. Add `list_listener_instances` tool

**Current state:** No tool exists to enumerate all configured instances for a multi-instance connection. The only way to discover instances is:

- `ingestor_status` — only returns **running** instances (stopped/disabled instances are invisible)
- `get_listener_params` — requires an `instance_id` to be already known

**Problem:** In remote mode, callboard derives the instance list from `ingestor_status`. This means:

- Newly created instances that haven't started their ingestor yet are invisible
- Stopped or disabled instances are invisible
- If `ingestor_status` fails (e.g., due to transient errors), the instance list is empty

**Proposed tool:**

```
list_listener_instances
  Input: { connection: string }
  Output: {
    success: true,
    connection: string,
    instances: Array<{
      instanceId: string,
      params: Record<string, unknown>,
      disabled: boolean
    }>
  }
```

**Implementation:** Read from `callerConfig.listenerInstances[connection]` and return all entries. This is the same data that callboard's `listListenerInstances()` in `connection-manager.ts` reads locally.

---

## 3. `get_listener_params` should enumerate instances when no `instance_id` given on multi-instance connections

**File:** `src/remote/server.ts` — `get_listener_params` handler (line 740)

**Current behavior:** When called without `instance_id`, returns single-instance overrides from `ingestorOverrides[connection].params`. For multi-instance connections, this is the wrong data source — the per-instance params live in `listenerInstances[connection][instanceId]`.

**Proposed enhancement:** When `instance_id` is omitted on a connection with `supportsMultiInstance: true`, return a list of instance IDs alongside the single-instance defaults:

```json
{
  "success": true,
  "connection": "trello",
  "params": {},
  "defaults": { "boardId": null, "bufferSize": 200 },
  "instances": ["board-abc123", "board-def456"]
}
```

This would give callers (including the callboard UI) a way to discover instances without needing the separate `list_listener_instances` tool, though having both would be ideal.

---

## Summary

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | `set_listener_params` doesn't restart ingestors | High | Small — add one `restartOne()` call |
| 2 | No `list_listener_instances` tool | High | Medium — new tool handler + schema |
| 3 | `get_listener_params` should hint at existing instances | Low | Small — add optional `instances` array to response |
