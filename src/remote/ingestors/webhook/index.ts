// ── Generic base class ──────────────────────────────────────────────────
export { WebhookIngestor } from './base-webhook-ingestor.js';

// ── GitHub provider ─────────────────────────────────────────────────────
export { GitHubWebhookIngestor } from './webhook-ingestor.js';
export {
  verifyGitHubSignature,
  extractGitHubHeaders,
  type GitHubWebhookHeaders,
  GITHUB_EVENT_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GITHUB_DELIVERY_HEADER,
} from './types.js';

// ── Stripe provider ─────────────────────────────────────────────────────
export { StripeWebhookIngestor } from './stripe-webhook-ingestor.js';
export {
  verifyStripeSignature,
  parseStripeSignatureHeader,
  type StripeSignatureComponents,
  STRIPE_SIGNATURE_HEADER,
  DEFAULT_TIMESTAMP_TOLERANCE,
} from './stripe-types.js';
