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
