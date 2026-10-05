# Drawlatch contributor notes

Drawlatch is an encrypted MCP proxy. A local stdio MCP server (`src/mcp/server.ts`) forwards encrypted tool calls to a daemon (`src/remote/server.ts`) that holds secrets, calls allowlisted APIs, runs event listeners, and serves the admin dashboard (`frontend/`). The CLI is `bin/drawlatch.js` and imports from `dist/`, so build before running it from a checkout.

## Commands

```bash
npm run build                                     # tsc + copy src/connections to dist + build frontend
npx vitest run <file> --maxWorkers=2              # run the tests you touched
npm test                                          # all unit tests; test:e2e needs .env.e2e (live APIs)
npm run lint && npm run format:check
```

To try the daemon without touching your real setup, set `MCP_CONFIG_DIR` to a temp directory and use a non-default port in its `remote.config.json`.

## Where things live

- **Tool implementations:** `src/remote/tool-dispatch.ts`. They're shared by the encrypted `/request` path and the admin API (`src/remote/admin*.ts`). An agent-facing tool also has to be registered in `src/mcp/server.ts`.
- **Connection templates:** `src/connections/<category>/<alias>.json`. The alias is the filename. Secrets referenced in `headers` count as required; the rest are optional.
- **Config:** schema, defaults, secret resolution, and timeout constants are in `src/shared/config.ts`. Secrets resolve from a caller's `env` literal or `<ALIAS>_<NAME>` only, never a bare env var.
- **Listeners:** `src/remote/ingestors/` (manager, plus `discord/`, `slack/`, `webhook/`, `poll/`).
- **`plans/`:** design records. Leave them as they are.

## Docs

Each topic has one home. Update it in the same change as the code:

- `README.md`: setup, config keys and defaults, secrets, timeouts, MCP tools, dashboard, CLI, exports.
- `CONNECTIONS.md`: the template table and per-connection notes. Update it when adding or changing a template.
- `INGESTORS.md`: listener behaviour, listener tools, overrides, and template ingestor fields.

Check claims by running the code (`drawlatch <cmd> --help`, a temp `MCP_CONFIG_DIR`) rather than copying from older docs.
