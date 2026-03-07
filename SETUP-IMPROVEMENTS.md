# Drawlatch Remote Setup: Improvement Plan

Comprehensive list of improvements to the first-time remote mode setup experience.
Identified by walking through every step a new user takes from `git clone` to first successful `secure_request`.

---

## P0 — Critical: First-Time Setup is Too Manual

### 1. Add `drawlatch init` Command

**Problem:** Setting up remote mode requires 6+ manual steps across 3 config files, 4 key-gen commands, and 6 file-copy commands. Most first-time users run both sides on the same machine and shouldn't need to do any of this by hand.

**Tasks:**

- [ ] Add `init` subcommand to `bin/drawlatch.js`
- [ ] Generate remote server keypair (`keys/remote/`) if not present
- [ ] Generate local proxy keypair (`keys/local/default/`) if not present
- [ ] Auto-copy public keys into correct peer directories:
  - `keys/local/default/*.pub.pem` -> `keys/peers/default/`
  - `keys/remote/*.pub.pem` -> `keys/peers/remote-server/`
- [ ] Scaffold `proxy.config.json` with defaults (remoteUrl, localKeyAlias, remotePublicKeysDir)
- [ ] Scaffold `remote.config.json` with a `"default"` caller referencing the generated keys
- [ ] Create a template `.env` file with commented-out entries for common connections
- [ ] Print summary of everything created, with next-steps instructions
- [ ] Support `--connections github,slack` flag to pre-enable connections in the scaffolded config
- [ ] Support `--alias <name>` flag to name the local identity (default: `"default"`)
- [ ] Skip steps that are already done (idempotent — safe to re-run)

**Acceptance:** A new user can go from `npm install -g @wolpertingerlabs/drawlatch` to `drawlatch start` with only `drawlatch init` in between.

---

### 2. Pre-flight Validation with Actionable Errors

**Problem:** When keys or config files are missing, the server throws raw `ENOENT` errors from `fs.readFileSync` with no guidance on how to fix. When all callers have missing peer keys, the server starts with 0 authorized peers and silently rejects every handshake.

**Tasks:**

- [ ] In `remote/server.ts` `main()`, validate remote key directory exists before calling `createApp()`
  - If missing: `"Remote server keys not found at ~/.drawlatch/keys/remote/. Run: drawlatch generate-keys remote"`
- [ ] In `remote/server.ts` `main()`, validate `remote.config.json` exists
  - If missing: `"No remote config found. Run: drawlatch init"`
- [ ] In `loadCallerPeers()`, after the loop, warn loudly if `peers.length === 0`:
  - `"WARNING: No authorized peers loaded. No clients will be able to connect. Check peer key directories in remote.config.json."`
- [ ] In `mcp/server.ts` `main()`, validate `proxy.config.json` exists
  - If missing: `"No proxy config found at ~/.drawlatch/proxy.config.json. Run: drawlatch init"`
- [ ] In `loadProxyConfig()`, validate the resolved `localKeysDir` exists
  - If missing: `"Local proxy keys not found at <path>. Run: drawlatch generate-keys local <alias>"`
- [ ] In `loadProxyConfig()`, validate `remotePublicKeysDir` exists
  - If missing: `"Remote server public keys not found at <path>. See: drawlatch init or copy keys manually."`
- [ ] Wrap `loadKeyBundle()` calls with try/catch that translates `ENOENT` into human-readable messages pointing to the correct generate-keys command

**Acceptance:** Every missing-file scenario produces a one-line error with the exact command to fix it.

---

## P1 — Important: Silent Failures That Waste Time

### 3. Boot-Time Connection Health Table

**Problem:** The `.env` file and API secrets are never mentioned in the quick start flow. Users enable connections in config but never set the required env vars. `resolveSecrets()` prints a `console.error` warning that scrolls past in server logs. The first API call fails with a 401 from the external service, and the user doesn't know why.

**Tasks:**

- [ ] At server startup (after config load, before listen), iterate all callers' enabled connections
- [ ] For each connection, check whether its required secrets are set (env var exists and is non-empty)
- [ ] Print a startup diagnostic table to the console:
  ```
  [remote] Connection status:
    github       GITHUB_TOKEN              [SET]
    discord-bot  DISCORD_BOT_TOKEN         [NOT SET] <-- will fail
    stripe       STRIPE_SECRET_KEY         [NOT SET] <-- will fail
  ```
- [ ] Classify secrets as "required" (referenced in route headers) vs "optional" (ingestor-only, etc.)
- [ ] Warn (not error) for missing optional secrets; error-level for missing required secrets
- [ ] Add this same check to `drawlatch config` output

**Acceptance:** A user can see at a glance which connections will work and which need env vars set.

---

### 4. Proxy Startup Health Check + Better Handshake Errors

**Problem:** The MCP proxy doesn't connect to the remote server until the first tool call. If the remote server isn't running, the tool call hangs for 10 seconds then returns a generic error. Users don't know if the problem is the server not running, keys mismatched, or config wrong.

**Tasks:**

- [ ] In `mcp/server.ts` `main()`, after transport connect, perform a non-blocking health check:
  ```
  fetch(`${remoteUrl}/health`, { signal: AbortSignal.timeout(3000) })
  ```
  - On success: `"[mcp-proxy] Remote server reachable at http://127.0.0.1:9999"`
  - On failure: `"[mcp-proxy] WARNING: Remote server at http://127.0.0.1:9999 is not reachable. Start it with: drawlatch start"`
  - Do NOT block MCP server startup — this is advisory only
- [ ] In `establishChannel()`, catch fetch errors and provide specific messages:
  - `ECONNREFUSED` -> `"Remote server is not running at <url>. Start it with: drawlatch start"`
  - `AbortError` / timeout -> `"Remote server at <url> is not responding (timed out after Xs)"`
  - HTTP 401 -> `"Authentication failed. Check that public keys are correctly exchanged. See: drawlatch init"`
  - HTTP 403 -> `"Caller not authorized. Verify your key alias matches a caller in remote.config.json."`
- [ ] In `sendEncryptedRequest()`, when session re-establishment fails, include the underlying cause

**Acceptance:** Users always know *why* a request failed and *what to do* about it.

---

### 5. `.env` Mentioned in Setup + Template Creation

**Problem:** The README setup walkthrough never creates a `.env` file. Users discover its need only when API calls fail.

**Tasks:**

- [ ] `drawlatch init` creates `~/.drawlatch/.env` with commented template (covered in item 1)
- [ ] Add `.env` creation to README Step 4 (remote config), with example:
  ```
  # Create env file with your API secrets
  cat > ~/.drawlatch/.env << 'EOF'
  # Uncomment and set tokens for your enabled connections
  # GITHUB_TOKEN=ghp_your_token_here
  # DISCORD_BOT_TOKEN=your_bot_token_here
  EOF
  ```
- [ ] `drawlatch config` shows `.env` path and per-connection secret status
- [ ] Add a `drawlatch env set GITHUB_TOKEN=ghp_xxx` convenience command (writes to `.env` + sets `process.env`)
- [ ] Add a `drawlatch env list` command showing all set/unset secrets for enabled connections

**Acceptance:** Users never have to guess where secrets go or how to set them.

---

## P2 — Quality of Life

### 6. Key Fingerprints in Rejection Logs

**Problem:** When keys are mismatched (wrong public keys exchanged, swapped local/remote), the handshake silently fails with a 401. The server log shows no detail about *whose* key failed or *why*.

**Tasks:**

- [ ] In `HandshakeResponder.processInit()`, when no matching peer is found, log the connecting client's signing key fingerprint:
  ```
  [remote] Handshake rejected: no authorized peer matches fingerprint ab:cd:ef:...
  [remote] Authorized peer fingerprints:
  [remote]   default: 12:34:56:...
  ```
- [ ] Add fingerprint display to `drawlatch status` output:
  ```
  Remote key fingerprint:   ab:cd:ef:...
  Local key fingerprint:    12:34:56:...
  ```
- [ ] Add fingerprint display to `drawlatch config` output (both local and remote keys, plus all peers)
- [ ] On proxy-side handshake failure (401), log:
  ```
  [mcp-proxy] Handshake rejected by server. Your key fingerprint: 12:34:56:...
  [mcp-proxy] Ensure this fingerprint matches an authorized peer on the remote server.
  ```

**Acceptance:** A key mismatch can be diagnosed in under 30 seconds by comparing fingerprints.

---

### 7. Simplify `MCP_CONFIG_DIR` Handling

**Problem:** `MCP_CONFIG_DIR` must be set as a shell env var before Claude Code launches for the `.mcp.json` passthrough to work. There's no indication when it's not set, and the fallback to `~/.drawlatch` only works if that happens to be what the user intended.

**Tasks:**

- [ ] Make `~/.drawlatch` the documented and recommended default; remove emphasis on `MCP_CONFIG_DIR` from Quick Start
- [ ] In `getConfigDir()`, log a one-time debug message when using default vs env override
- [ ] In `.mcp.json`, add a comment (or in README) explaining that `MCP_CONFIG_DIR` is optional and defaults to `~/.drawlatch`
- [ ] In the plugin manifest, consider hardcoding `~/.drawlatch` as the default instead of requiring the env var passthrough
- [ ] Document `MCP_CONFIG_DIR` as an "Advanced" option for non-standard deployments

**Acceptance:** Users who use the default `~/.drawlatch` path never need to think about `MCP_CONFIG_DIR`.

---

## P3 — Nice to Have

### 8. Multi-Machine Key Exchange Tooling

**Problem:** When the proxy and remote server are on different machines, exchanging public keys requires manual `scp` of 4 files into the correct directories. Easy to get wrong.

**Tasks:**

- [ ] Add `drawlatch export-keys <alias>` — bundles public keys (signing + exchange) into a single JSON or tar file for transfer
- [ ] Add `drawlatch import-keys <alias> <file>` — imports a public key bundle into `keys/peers/<alias>/`
- [ ] Alternative: `drawlatch export-keys <alias> --stdout` prints base64-encoded bundle for pipe/paste workflows
- [ ] Document the multi-machine workflow in README with these commands

**Acceptance:** Exchanging keys between machines is a copy-paste or single-scp operation.

---

### 9. `drawlatch doctor` — Comprehensive Setup Validator

**Problem:** There's no single command to validate that the entire setup is correct and ready to use.

**Tasks:**

- [ ] Add `doctor` subcommand to `bin/drawlatch.js`
- [ ] Check: Config directory exists
- [ ] Check: Remote config file exists and parses
- [ ] Check: Proxy config file exists and parses
- [ ] Check: Remote server keys exist (all 4 PEM files)
- [ ] Check: Local proxy keys exist (all 4 PEM files)
- [ ] Check: Peer key directories exist for all callers in remote config
- [ ] Check: Peer key directory for remote server exists (referenced from proxy config)
- [ ] Check: Key fingerprints match across peer directories (local -> peer/remote-server matches actual remote keys)
- [ ] Check: `.env` file exists
- [ ] Check: Required secrets for enabled connections are set
- [ ] Check: Remote server is reachable (health check)
- [ ] Check: Handshake succeeds (optional, with `--full` flag)
- [ ] Print pass/fail table with remediation commands for each failure

**Example output:**
```
$ drawlatch doctor

Drawlatch Setup Check
=====================
Config directory (~/.drawlatch/)          PASS
Remote config (remote.config.json)        PASS
Proxy config (proxy.config.json)          PASS
Remote server keys (keys/remote/)         PASS
Local proxy keys (keys/local/default/)    PASS
Peer keys for "default" (keys/peers/default/)           PASS
Peer keys for remote (keys/peers/remote-server/)        PASS
Environment file (.env)                   PASS
  github: GITHUB_TOKEN                   PASS
  discord-bot: DISCORD_BOT_TOKEN         FAIL  -> Set in ~/.drawlatch/.env
Remote server health (127.0.0.1:9999)    PASS

Result: 10/11 checks passed
```

**Acceptance:** Running `drawlatch doctor` tells you exactly what's wrong and how to fix it.

---

### 10. Streamline README Quick Start

**Problem:** The current README Quick Start for remote mode spans 6 numbered sections with extensive manual steps. It reads more like a reference than a getting-started guide.

**Tasks:**

- [ ] Add a "30-Second Quick Start" section at the top of Setup:
  ```
  npm install -g @wolpertingerlabs/drawlatch
  drawlatch init --connections github
  # Set your GitHub token when prompted (or edit ~/.drawlatch/.env)
  drawlatch start
  ```
- [ ] Keep existing detailed steps as "Manual Setup" for users who need custom configurations
- [ ] Add a "Verify It Works" section after start:
  ```
  drawlatch status        # Check server is running
  drawlatch doctor        # Validate full setup
  ```
- [ ] Move `MCP_CONFIG_DIR` docs to an "Advanced Configuration" section

**Acceptance:** A user can get from zero to working in under 2 minutes by following the Quick Start.

---

## Implementation Notes

### Dependency Order

```
Item 1 (drawlatch init)     <- foundation, enables everything else
Item 2 (pre-flight errors)  <- can be done independently
Item 3 (health table)       <- needs connection template introspection (already exists)
Item 4 (proxy health check) <- independent
Item 5 (.env tooling)       <- partially depends on Item 1
Item 6 (fingerprints)       <- independent
Item 7 (MCP_CONFIG_DIR)     <- independent, mostly docs
Item 8 (key export/import)  <- independent
Item 9 (drawlatch doctor)   <- benefits from Items 2, 3, 6
Item 10 (README)            <- should be done after Items 1, 9
```

### Files Primarily Affected

| File | Items |
|------|-------|
| `bin/drawlatch.js` | 1, 5, 8, 9 |
| `src/remote/server.ts` | 2, 3, 6 |
| `src/mcp/server.ts` | 2, 4 |
| `src/shared/config.ts` | 2, 7 |
| `src/shared/crypto/keys.ts` | 6 |
| `src/shared/protocol/handshake.ts` | 6 |
| `README.md` | 5, 7, 10 |
