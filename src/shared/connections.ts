/**
 * Connection template loading.
 *
 * Connections are pre-built Route templates (JSON files) that ship with
 * the package in the connections/ directory, organized into category
 * subdirectories (ai/, messaging/, social-media/, etc.).
 *
 * At runtime, templates are loaded from disk relative to this module's
 * location, so they work from both src/ (dev via tsx) and dist/ (production).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_SIGV4_REQUIRED_SECRETS, type Route, type ConnectionCategory } from './config.js';

/** Metadata about a built-in connection template — used by UIs to render
 *  connection cards, form fields, and badges without parsing raw JSON. */
export interface ConnectionTemplateInfo {
  /** Template alias / filename (e.g., "github", "slack"). */
  alias: string;
  /** Human-readable name (e.g., "GitHub API"). */
  name: string;
  /** Short description of the connection's purpose. */
  description?: string;
  /** Link to API documentation. */
  docsUrl?: string;
  /** URL to an OpenAPI / Swagger spec. */
  openApiUrl?: string;
  /** Stability level: "stable", "beta", or "dev". */
  stability: 'stable' | 'beta' | 'dev';
  /** Category grouping (e.g., "ai", "messaging", "social-media"). */
  category: ConnectionCategory;
  /** Secret names every request authenticates with — placeholders in route
   *  headers, plus AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY on an `awsSigV4`
   *  route — so they must always be configured. */
  requiredSecrets: string[];
  /** Secret names defined in the template but not required for auth.
   *  Used by ingestors, URL placeholders, body templates, AWS_SESSION_TOKEN, etc. */
  optionalSecrets: string[];
  /** Whether this connection has an ingestor for real-time events. */
  hasIngestor: boolean;
  /** Ingestor type, when present. */
  ingestorType?: 'websocket' | 'webhook' | 'poll';
  /** Whether this connection has a pre-configured test request. */
  hasTestConnection: boolean;
  /** Whether this connection's ingestor has a pre-configured test. */
  hasTestIngestor: boolean;
  /** Whether this connection has a listener configuration schema. */
  hasListenerConfig: boolean;
  /** Whether this connection's listener supports multiple concurrent instances
   *  (e.g., watching multiple Trello boards or Reddit subreddits simultaneously). */
  supportsMultiInstance: boolean;
  /** Allowlisted URL patterns (glob). */
  allowedEndpoints: string[];
}

/** Directory containing connection template JSON files. */
const CONNECTIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connections',
);

// ── Lazy-cached alias→filepath index ──────────────────────────────────────

/** Cached alias → absolute filepath index. Built lazily on first access.
 *  Templates live in category subdirectories (connections/ai/anthropic.json). */
let connectionIndex: Map<string, string> | null = null;

/** Build the alias→filepath index by scanning CONNECTIONS_DIR.
 *  Templates live one level deep, in category subdirectories. The alias is
 *  always the filename without .json. */
function getConnectionIndex(): Map<string, string> {
  if (connectionIndex) return connectionIndex;

  connectionIndex = new Map();
  if (!fs.existsSync(CONNECTIONS_DIR)) return connectionIndex;

  const entries = fs.readdirSync(CONNECTIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Category subdirectory — scan one level deep
      const subdir = path.join(CONNECTIONS_DIR, entry.name);
      const subEntries = fs.readdirSync(subdir, 'utf-8');
      for (const subFile of subEntries) {
        if (subFile.endsWith('.json')) {
          const alias = subFile.replace(/\.json$/, '');
          connectionIndex.set(alias, path.join(subdir, subFile));
        }
      }
    }
  }

  return connectionIndex;
}

/** Invalidate the cached index. Exported for testing only. */
export function _resetConnectionIndex(): void {
  connectionIndex = null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load a single connection template by name.
 *
 * @param name — Connection name (e.g., "github", "stripe", "trello").
 *               Must match the filename without the .json extension.
 * @returns The parsed Route object from the template.
 * @throws If the template file does not exist or contains invalid JSON.
 */
export function loadConnection(name: string): Route {
  const index = getConnectionIndex();
  const filePath = index.get(name);

  if (!filePath) {
    const available = listAvailableConnections();
    throw new Error(
      `Unknown connection "${name}". Available connections: ${available.join(', ') || '(none)'}`,
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Route;
}

/**
 * List all available connection template names.
 *
 * Scans the connections directory (including category subdirectories) for
 * .json files and returns their basenames (without extension), sorted
 * alphabetically.
 */
export function listAvailableConnections(): string[] {
  const index = getConnectionIndex();
  return [...index.keys()].sort();
}

// ── Template introspection ────────────────────────────────────────────────

/** Extract ${VAR} placeholder names from a string. */
function extractPlaceholderNames(str: string): Set<string> {
  const names = new Set<string>();
  for (const match of str.matchAll(/\$\{(\w+)\}/g)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * List all available connection templates with structured metadata.
 *
 * For each built-in template, returns its name, description, docs links,
 * secrets (categorized as required vs. optional), ingestor info, and
 * allowed endpoints.
 *
 * Secret categorization:
 *   - **required** — referenced in route `headers` values, or the signing
 *     keys of an `awsSigV4` route (used on every outgoing request, so they
 *     must always be configured).
 *   - **optional** — every other entry in the template's `secrets` map (used
 *     by ingestors, URL placeholders, an AWS session token, etc.).
 *
 * Used by:
 *   - the remote server's tool dispatch and boot-time health table
 *   - the admin dashboard API (src/remote/admin.ts)
 *   - the drawlatch CLI (bin/drawlatch.js)
 */
export function listConnectionTemplates(): ConnectionTemplateInfo[] {
  return listAvailableConnections().map((alias) => {
    const route = loadConnection(alias);

    // Collect secret names every request authenticates with: placeholders in
    // header values, plus the signing keys of an awsSigV4 route
    const authSecretNames = new Set<string>();
    for (const value of Object.values(route.headers ?? {})) {
      for (const name of extractPlaceholderNames(value)) {
        authSecretNames.add(name);
      }
    }
    if (route.awsSigV4) {
      for (const name of AWS_SIGV4_REQUIRED_SECRETS) authSecretNames.add(name);
    }

    // Partition secrets into required (used for auth) vs optional (elsewhere)
    const allSecretNames = Object.keys(route.secrets ?? {});
    const requiredSecrets = allSecretNames.filter((s) => authSecretNames.has(s));
    const optionalSecrets = allSecretNames.filter((s) => !authSecretNames.has(s));

    return {
      alias,
      name: route.name ?? alias,
      ...(route.description !== undefined && { description: route.description }),
      ...(route.docsUrl !== undefined && { docsUrl: route.docsUrl }),
      ...(route.openApiUrl !== undefined && { openApiUrl: route.openApiUrl }),
      stability: route.stability ?? 'dev',
      category: route.category!,
      requiredSecrets,
      optionalSecrets,
      hasIngestor: route.ingestor !== undefined,
      ...(route.ingestor !== undefined && { ingestorType: route.ingestor.type }),
      hasTestConnection: route.testConnection !== undefined,
      hasTestIngestor: route.testIngestor !== undefined && route.testIngestor !== null,
      hasListenerConfig: route.listenerConfig !== undefined,
      supportsMultiInstance: route.listenerConfig?.supportsMultiInstance ?? false,
      allowedEndpoints: route.allowedEndpoints,
    };
  });
}
