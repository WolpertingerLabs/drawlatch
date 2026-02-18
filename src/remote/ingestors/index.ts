// ── Shared infrastructure ────────────────────────────────────────────────
export {
  type IngestorConfig,
  type WebSocketIngestorConfig,
  type WebhookIngestorConfig,
  type PollIngestorConfig,
  type IngestedEvent,
  type IngestorState,
  type IngestorStatus,
  DEFAULT_BUFFER_SIZE,
  MAX_BUFFER_SIZE,
} from './types.js';

export { RingBuffer } from './ring-buffer.js';
export { BaseIngestor } from './base-ingestor.js';
export { IngestorManager } from './manager.js';
export { registerIngestorFactory, createIngestor } from './registry.js';

// ── Providers (each self-registers on import) ────────────────────────────
export {
  DiscordGatewayIngestor,
  DiscordIntents,
  ALL_INTENTS,
  ALL_NON_PRIVILEGED_INTENTS,
} from './discord/index.js';

export { SlackSocketModeIngestor } from './slack/index.js';

// ── Webhook providers ────────────────────────────────────────────────────
export { GitHubWebhookIngestor } from './webhook/index.js';
export {
  verifyGitHubSignature,
  extractGitHubHeaders,
  type GitHubWebhookHeaders,
} from './webhook/index.js';
