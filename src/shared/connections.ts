/**
 * Connection template loading.
 *
 * Connections are pre-built Route templates (JSON files) that ship with
 * the package in the connections/ directory. They provide ready-made
 * configurations for popular APIs (GitHub, Stripe, Trello, etc.).
 *
 * At runtime, templates are loaded from disk relative to this module's
 * location, so they work from both src/ (dev via tsx) and dist/ (production).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from './config.js';

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
  /** Secret names referenced in route headers — these are auto-injected
   *  into every request, so they must always be configured. */
  requiredSecrets: string[];
  /** Secret names defined in the template but NOT referenced in headers.
   *  Used by ingestors, URL placeholders, body templates, etc. */
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
  /** Allowlisted URL patterns (glob). */
  allowedEndpoints: string[];
}

/** Directory containing connection template JSON files. */
const CONNECTIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connections',
);

/**
 * Load a single connection template by name.
 *
 * @param name — Connection name (e.g., "github", "stripe", "trello").
 *               Must match the filename without the .json extension.
 * @returns The parsed Route object from the template.
 * @throws If the template file does not exist or contains invalid JSON.
 */
export function loadConnection(name: string): Route {
  const filePath = path.join(CONNECTIONS_DIR, `${name}.json`);

  if (!fs.existsSync(filePath)) {
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
 * Scans the connections directory for .json files and returns their
 * basenames (without extension), sorted alphabetically.
 */
export function listAvailableConnections(): string[] {
  if (!fs.existsSync(CONNECTIONS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(CONNECTIONS_DIR, 'utf-8')
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
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
 *   - **required** — referenced in route `headers` values (auto-injected
 *     into every outgoing request, so they must always be configured).
 *   - **optional** — defined in the template's `secrets` map but not
 *     referenced in headers (used by ingestors, URL placeholders, etc.).
 *
 * Used by:
 *   - callboard's ConnectionManager (local mode, direct import)
 *   - admin_list_connection_templates tool handler (remote mode, Stage 3)
 */
export function listConnectionTemplates(): ConnectionTemplateInfo[] {
  return listAvailableConnections().map((alias) => {
    const route = loadConnection(alias);

    // Collect secret names referenced in header values
    const headerSecretNames = new Set<string>();
    for (const value of Object.values(route.headers ?? {})) {
      for (const name of extractPlaceholderNames(value)) {
        headerSecretNames.add(name);
      }
    }

    // Partition secrets into required (in headers) vs optional (elsewhere)
    const allSecretNames = Object.keys(route.secrets ?? {});
    const requiredSecrets = allSecretNames.filter((s) => headerSecretNames.has(s));
    const optionalSecrets = allSecretNames.filter((s) => !headerSecretNames.has(s));

    return {
      alias,
      name: route.name ?? alias,
      ...(route.description !== undefined && { description: route.description }),
      ...(route.docsUrl !== undefined && { docsUrl: route.docsUrl }),
      ...(route.openApiUrl !== undefined && { openApiUrl: route.openApiUrl }),
      requiredSecrets,
      optionalSecrets,
      hasIngestor: route.ingestor !== undefined,
      ...(route.ingestor !== undefined && { ingestorType: route.ingestor.type }),
      hasTestConnection: route.testConnection !== undefined,
      hasTestIngestor: route.testIngestor !== undefined && route.testIngestor !== null,
      hasListenerConfig: route.listenerConfig !== undefined,
      allowedEndpoints: route.allowedEndpoints,
    };
  });
}
