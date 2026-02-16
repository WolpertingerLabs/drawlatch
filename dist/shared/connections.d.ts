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
import type { Route } from './config.js';
/**
 * Load a single connection template by name.
 *
 * @param name — Connection name (e.g., "github", "stripe", "trello").
 *               Must match the filename without the .json extension.
 * @returns The parsed Route object from the template.
 * @throws If the template file does not exist or contains invalid JSON.
 */
export declare function loadConnection(name: string): Route;
/**
 * List all available connection template names.
 *
 * Scans the connections directory for .json files and returns their
 * basenames (without extension), sorted alphabetically.
 */
export declare function listAvailableConnections(): string[];
//# sourceMappingURL=connections.d.ts.map