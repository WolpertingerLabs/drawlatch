/**
 * Shared types for the ingestor subsystem.
 *
 * Ingestors are long-lived data collectors that run on the remote server,
 * pulling real-time events from external services (Discord Gateway, webhooks,
 * polling) and buffering them for the MCP proxy to retrieve via `poll_events`.
 */
// ── Constants ───────────────────────────────────────────────────────────
/** Default ring buffer capacity per ingestor. */
export const DEFAULT_BUFFER_SIZE = 200;
/** Maximum allowed ring buffer capacity. */
export const MAX_BUFFER_SIZE = 1000;
//# sourceMappingURL=types.js.map