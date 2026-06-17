/**
 * Response DTOs for the daemon's `/admin/*` API (served at `/api/admin/*`).
 *
 * This file is the single source of truth for these shapes. `src/remote/admin.ts`
 * imports them to annotate its handler responses, and the frontend imports them
 * (type-only) instead of maintaining a duplicate `shared` mirror.
 *
 * Type-only — compiles to nothing.
 */

// ── /admin/meta ──────────────────────────────────────────────────────────
export interface AdminMeta {
  version: string;
  port: number;
  pid: number;
  startedAt: number;
  uptimeSec: number;
  configPath: string;
  callerKeysDir: string;
  serverKeysDir: string;
  envFilePath: string;
  /** Public URL of the self-managed cloudflared tunnel, when active (item C). */
  tunnelUrl: string | null;
}

// ── /admin/health ────────────────────────────────────────────────────────
export interface AdminIngestorCounts {
  connected: number;
  error: number;
  starting: number;
  stopped: number;
}

export interface AdminHealth {
  status: 'ok';
  activeSessions: number;
  ingestorCounts: AdminIngestorCounts;
  uptimeSec: number;
}

// ── /admin/callers ───────────────────────────────────────────────────────
export interface AdminCaller {
  alias: string;
  name: string | null;
  connections: string[];
  envKeys: string[];
  fingerprint: string | null;
  keysDirExists: boolean;
}

// ── /admin/connections ───────────────────────────────────────────────────
export type ConnectionCategory =
  | 'ai'
  | 'developer-tools'
  | 'gaming'
  | 'messaging'
  | 'productivity'
  | 'social-media';

export interface AdminConnectionTemplate {
  alias: string;
  name: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  stability: 'stable' | 'beta' | 'dev';
  category: ConnectionCategory;
  requiredSecrets: string[];
  optionalSecrets: string[];
  hasIngestor: boolean;
  ingestorType?: 'websocket' | 'webhook' | 'poll';
  hasTestConnection: boolean;
  hasTestIngestor: boolean;
  hasListenerConfig: boolean;
  supportsMultiInstance: boolean;
  allowedEndpoints: string[];
}

// ── /admin/callers/:alias/connection-status ──────────────────────────────
/** Per-caller status for EVERY connection template — whether the caller has it
 *  enabled, and which secrets are configured (booleans only, never values).
 *  This is the one-call payload the dashboard Connections page renders from. */
export interface AdminConnectionStatus extends AdminConnectionTemplate {
  enabled: boolean;
  requiredSecretsSet: Record<string, boolean>;
  optionalSecretsSet: Record<string, boolean>;
}

// ── /admin/callers/:alias/connections ────────────────────────────────────
export interface AdminSecretRef {
  name: string;
  present: boolean;
}

export interface AdminListenerInstance {
  instanceId: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface AdminCallerConnection {
  connectionAlias: string;
  enabled: boolean;
  isCustom: boolean;
  requiredSecrets: AdminSecretRef[];
  optionalSecrets: AdminSecretRef[];
  hasIngestor: boolean;
  instances: AdminListenerInstance[];
}

// ── /admin/ingestors ─────────────────────────────────────────────────────
export type IngestorState = 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'error';

export interface AdminIngestor {
  callerAlias: string;
  connection: string;
  instanceId?: string;
  type: 'websocket' | 'webhook' | 'poll';
  state: IngestorState;
  bufferedEvents: number;
  totalEventsReceived: number;
  lastEventAt: string | null;
  error?: string;
  webhookRegistration?: {
    registered: boolean;
    webhookId?: string;
    error?: string;
  };
}

// ── /admin/sessions ──────────────────────────────────────────────────────
export interface AdminSession {
  sessionIdShort: string;
  callerAlias: string;
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  windowRequests: number;
  windowStart: number;
}

// ── /admin/callers/:alias/events ─────────────────────────────────────────
/** A buffered ingestor event, as surfaced to the dashboard Logs viewer.
 *  This is the ingested payload from an external service (e.g. a Discord
 *  message) — never a drawlatch secret. */
export interface AdminEvent {
  id: number;
  idempotencyKey: string;
  receivedAt: string;
  receivedAtMs: number;
  callerAlias: string;
  source: string;
  instanceId?: string;
  eventType: string;
  data: unknown;
}

// ── /admin/secrets ───────────────────────────────────────────────────────
export interface AdminSecret {
  callerAlias: string;
  connection: string;
  name: string;
  required: boolean;
  present: boolean;
}

// ── Daemon reachability envelope ─────────────────────────────────────────
/**
 * Legacy envelope from the standalone drawlatch-ui backend, which proxied to a
 * separate daemon process and needed to surface an "offline" state when that
 * process was unreachable. Retained as a type for the frontend's transition;
 * same-origin calls in the merged daemon cannot refuse themselves.
 */
export interface DaemonOfflineEnvelope {
  daemon: 'down';
  error: string;
}
