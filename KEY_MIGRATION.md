# Key Storage Simplification

## Goal

Rename the key directory structure from `local`/`remote`/`peers` to `callers`/`server`, eliminating:
- The collision risk where a caller alias could conflict with the hardcoded `remote-server` peer name
- Redundant path fields in config files (`localKeysDir`, `remotePublicKeysDir`, `peerKeyDir`) that are always derivable from the config directory and caller alias

## Current Layout (3 concepts, collision risk)

```
keys/
├── local/<alias>/           — Caller keypairs
├── remote/                  — Server keypair
└── peers/
    ├── <alias>/             — Received caller public keys
    └── remote-server/       — Received server public keys  ← COLLISION RISK
```

The `peers/` directory mixes caller keys and server keys in one namespace. A caller alias of `remote-server` would collide with the hardcoded server entry.

## New Layout (2 concepts, no collision)

```
keys/
├── callers/<alias>/         — Caller keypairs (one subdir per alias)
└── server/                  — Server keypair (flat, no subdirs)
```

Each side stores what it owns (full keypair) and what it received (public keys only) in the same structure. `loadPublicKeys()` only reads `.pub.pem` files, so it works regardless of whether private keys are present.

### Drawlatch server (`~/.drawlatch/`)

```
keys/
├── callers/                 — Received caller PUBLIC keys (via sync)
│   ├── alice/
│   │   ├── signing.pub.pem
│   │   └── exchange.pub.pem
│   └── bob/
│       ├── signing.pub.pem
│       └── exchange.pub.pem
└── server/                  — Server's own FULL keypair
    ├── signing.key.pem
    ├── signing.pub.pem
    ├── exchange.key.pem
    └── exchange.pub.pem
```

### Callboard remote (`~/.callboard/.drawlatch.remote/`)

```
keys/
├── callers/                 — Caller's own FULL keypairs
│   ├── default/
│   │   ├── signing.key.pem
│   │   ├── signing.pub.pem
│   │   ├── exchange.key.pem
│   │   └── exchange.pub.pem
│   └── alice/
│       └── ...
└── server/                  — Server's received PUBLIC keys
    ├── signing.pub.pem
    └── exchange.pub.pem
```

### Callboard local (`~/.callboard/.drawlatch.local/`)

No `keys/` directory needed (no crypto in local mode).

---

## Config Simplification

All key paths are derivable from the config directory. No path fields needed in config files.

### `proxy.config.json` — Before

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "localKeyAlias": "default",
  "localKeysDir": "~/.callboard/.drawlatch.remote/keys/local/default",
  "remotePublicKeysDir": "~/.callboard/.drawlatch.remote/keys/peers/remote-server",
  "connectTimeout": 10000,
  "requestTimeout": 300000
}
```

### `proxy.config.json` — After

```json
{
  "remoteUrl": "http://127.0.0.1:9999",
  "connectTimeout": 10000,
  "requestTimeout": 300000
}
```

Key resolution at runtime:
- `MCP_KEY_ALIAS` env var (or `"default"`) → `{configDir}/keys/callers/{alias}/`
- Server keys → `{configDir}/keys/server/`

### `remote.config.json` — Before

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "localKeysDir": "~/.drawlatch/keys/remote",
  "rateLimitPerMinute": 60,
  "callers": {
    "alice": {
      "name": "Alice",
      "peerKeyDir": "~/.drawlatch/keys/peers/alice",
      "connections": ["github", "slack"]
    }
  }
}
```

### `remote.config.json` — After

```json
{
  "host": "0.0.0.0",
  "port": 9999,
  "rateLimitPerMinute": 60,
  "callers": {
    "alice": {
      "name": "Alice",
      "connections": ["github", "slack"]
    }
  }
}
```

Key resolution at runtime:
- Server keys → `{configDir}/keys/server/`
- Caller keys → `{configDir}/keys/callers/{alias}/` (alias = key in `callers` map)

---

## Changes

### 1. `config.ts` — Path helpers

| Old                    | New                     | Returns         |
| ---------------------- | ----------------------- | --------------- |
| `getLocalKeysDir()`    | `getCallerKeysDir()`    | `keys/callers`  |
| `getRemoteKeysDir()`   | `getServerKeysDir()`    | `keys/server`   |
| `getPeerKeysDir()`     | Remove                  |                 |

### 2. `config.ts` — Config interfaces

**`ProxyConfig`** (callboard side):

| Old field              | Action                                              |
| ---------------------- | --------------------------------------------------- |
| `localKeyAlias`        | Remove (use `MCP_KEY_ALIAS` env var or `"default"`) |
| `localKeysDir`         | Remove (derived from config dir + alias)            |
| `remotePublicKeysDir`  | Remove (always `{configDir}/keys/server/`)          |

**`RemoteServerConfig`** (server side):

| Old field              | Action                                              |
| ---------------------- | --------------------------------------------------- |
| `localKeysDir`         | Remove (always `{configDir}/keys/server/`)          |

**`CallerConfig`** (per-caller on server):

| Old field              | Action                                              |
| ---------------------- | --------------------------------------------------- |
| `peerKeyDir`           | Remove (derived from caller alias in `callers` map) |

### 3. `config.ts` — Loader changes

**`loadProxyConfig()`**:

Remove alias/path resolution logic. Return only `remoteUrl`, `connectTimeout`, `requestTimeout`. Callers of this function that need key paths derive them:

```typescript
const alias = process.env.MCP_KEY_ALIAS?.trim() || 'default';
const callerKeysDir = path.join(getCallerKeysDir(), alias);
const serverKeysDir = getServerKeysDir();
```

**`loadRemoteConfig()`**:

Remove `localKeysDir` from defaults and loaded config. Server key path is always `getServerKeysDir()`.

**`loadCallerPeers()`** (in `remote/server.ts`):

Derive key path from alias instead of reading `caller.peerKeyDir`:

```typescript
for (const [alias, caller] of Object.entries(callers)) {
  const keysDir = path.join(getCallerKeysDir(), alias);
  peers.push({ alias, name: caller.name, keys: loadPublicKeys(keysDir) });
}
```

### 4. `key-manager.ts`

**Renamed functions:**

| Old                                  | New                              | Path                       |
| ------------------------------------ | -------------------------------- | -------------------------- |
| `createCaller(alias)`                | `createCaller(alias)` (keep)     | `keys/callers/<alias>/`    |
| `exportPublicKeys('local', alias)`   | `exportCallerPublicKeys(alias)`  | `keys/callers/<alias>/`    |
| `exportPublicKeys('remote')`         | `exportServerPublicKeys()`       | `keys/server/`             |
| `importPeerPublicKeys(alias, keys)`  | `importCallerPublicKeys(alias, keys)` | `keys/callers/<alias>/` |
| `saveRemotePublicKeys(keys)`         | `saveServerPublicKeys(keys)`     | `keys/server/`             |
| `listCallers()`                      | `listCallers()` (keep)           | scans `keys/callers/`      |
| `callerExists(alias)`               | `callerExists(alias)` (keep)     | `keys/callers/<alias>/`    |
| `callerFingerprint(alias)`          | `callerFingerprint(alias)` (keep)| `keys/callers/<alias>/`    |

**Removed functions** (merged into above):

| Old                    | Replacement              |
| ---------------------- | ------------------------ |
| `listPeers()`          | `listCallers()`          |
| `peerExists(alias)`    | `callerExists(alias)`    |
| `peerFingerprint(alias)` | `callerFingerprint(alias)` |

**New functions:**

| Function               | Path                     |
| ---------------------- | ------------------------ |
| `serverExists()`       | `keys/server/`           |
| `serverFingerprint()`  | `keys/server/`           |

**Internal helpers:**

| Old                    | New                      |
| ---------------------- | ------------------------ |
| `localKeysDir(opts)`   | `callerKeysDir(opts)`    |
| `remoteKeysDir(opts)`  | `serverKeysDir(opts)`    |
| `peerKeysDir(opts)`    | Remove                   |

### 5. Sync protocol

**Server side** (`remote/server.ts` sync handler):

- `importPeerPublicKeys(alias, keys)` → `importCallerPublicKeys(alias, keys)` writes to `keys/callers/<alias>/`
- `exportPublicKeys('remote')` → `exportServerPublicKeys()` reads from `keys/server/`
- Remove `peerKeyDir` from config writes — just register the caller alias:
  ```typescript
  config.callers[callerAlias] = { connections: [] };
  ```
- `peerFingerprint(alias)` → `callerFingerprint(alias)`

**Client side** (`sync-client.ts`):

- `createCaller(alias)` → no change, writes to `keys/callers/<alias>/`
- `exportPublicKeys('local', alias)` → `exportCallerPublicKeys(alias)` reads from `keys/callers/<alias>/`
- `saveRemotePublicKeys(keys)` → `saveServerPublicKeys(keys)` writes to `keys/server/`

### 6. MCP proxy (`mcp/server.ts`)

- Derive caller keys dir: `path.join(getCallerKeysDir(), process.env.MCP_KEY_ALIAS || 'default')`
- Derive server keys dir: `getServerKeysDir()`
- Remove reads of `config.localKeysDir` and `config.remotePublicKeysDir`

### 7. Remote server (`remote/server.ts`)

- Derive server keys dir: `getServerKeysDir()`
- `loadCallerPeers()` derives paths from alias: `path.join(getCallerKeysDir(), alias)`
- Remove reads of `config.localKeysDir` and `caller.peerKeyDir`

### 8. Init command (`bin/drawlatch.js`)

- Server keypair → `keys/server/`
- Caller keypair → `keys/callers/<alias>/`
- No copy step to peers
- Config scaffolding omits all key path fields

### 9. `generate-keys` CLI

- `generate-keys local <alias>` → `generate-keys caller <alias>`
- `generate-keys remote` → `generate-keys server`

### 10. Doctor command

- Check `keys/server/` for server keypair
- Check `keys/callers/<alias>/` for each configured caller
- Remove `peers/remote-server` check

### 11. Callboard changes (separate repo)

**`proxy-singleton.ts`** `resolveKeyPaths()`:
- `keys/local/<alias>` → `keys/callers/<alias>`
- `keys/peers/remote-server` → `keys/server`

**`agent-settings.ts`** `ensureRemoteProxyConfigDir()`:
- Scaffold `keys/callers/default/` + `keys/server/`

**`discoverKeyAliases()`**:
- Scan `keys/callers/` instead of `keys/local/`

---

## Migration

Detect old layout on startup and warn with instructions:

| Old path                      | New path                  |
| ----------------------------- | ------------------------- |
| `keys/local/`                 | `keys/callers/`           |
| `keys/remote/`                | `keys/server/`            |
| `keys/peers/<alias>/`         | `keys/callers/<alias>/`   |
| `keys/peers/remote-server/`   | `keys/server/`            |

Old config field names (`localKeysDir`, `remotePublicKeysDir`, `localKeyAlias`, `peerKeyDir`) should be detected and ignored with a deprecation warning.
