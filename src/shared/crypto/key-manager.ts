/**
 * High-level key management API.
 *
 * Provides CRUD operations over the drawlatch key directory structure
 * so that callboard (and other consumers) can manage keys programmatically
 * without touching the filesystem directly.
 *
 * Key layout:
 *   keys/callers/<alias>/  — Caller keypairs (one per alias)
 *   keys/server/           — Server keypair (single, flat)
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  generateKeyBundle,
  saveKeyBundle,
  loadKeyBundle,
  loadPublicKeys,
  extractPublicKeys,
  serializePublicKeys,
  deserializePublicKeys,
  fingerprint,
  type SerializedPublicKeys,
} from './keys.js';
import { getCallerKeysDir, getServerKeysDir, getConfigDir } from '../config.js';

export interface CreateCallerResult {
  publicKeys: SerializedPublicKeys;
  fingerprint: string;
}

interface KeyManagerOpts {
  configDir?: string;
}

function resolveConfigDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return opts.configDir;
  return getConfigDir();
}

function callerKeysDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return path.join(opts.configDir, 'keys', 'callers');
  return getCallerKeysDir();
}

function serverKeysDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return path.join(opts.configDir, 'keys', 'server');
  return getServerKeysDir();
}

/**
 * Create a new caller identity (Ed25519 + X25519 keypairs).
 * Saves under `keys/callers/<alias>/`.
 * Throws if the alias already exists.
 */
export function createCaller(alias: string, opts?: KeyManagerOpts): CreateCallerResult {
  const dir = path.join(callerKeysDir(opts), alias);
  if (fs.existsSync(path.join(dir, 'signing.key.pem'))) {
    throw new Error(`Caller "${alias}" already exists at ${dir}`);
  }

  fs.mkdirSync(resolveConfigDir(opts), { recursive: true, mode: 0o700 });
  const bundle = generateKeyBundle();
  saveKeyBundle(bundle, dir);

  const pub = extractPublicKeys(bundle);
  return {
    publicKeys: serializePublicKeys(pub),
    fingerprint: fingerprint(pub),
  };
}

/**
 * Export public keys for a caller identity.
 * Reads from `keys/callers/<alias>/`.
 */
export function exportCallerPublicKeys(alias: string, opts?: KeyManagerOpts): SerializedPublicKeys {
  const dir = path.join(callerKeysDir(opts), alias);
  const pub = loadPublicKeys(dir);
  return serializePublicKeys(pub);
}

/**
 * Export public keys for the server.
 * Reads from `keys/server/`.
 */
export function exportServerPublicKeys(opts?: KeyManagerOpts): SerializedPublicKeys {
  const dir = serverKeysDir(opts);
  const pub = loadPublicKeys(dir);
  return serializePublicKeys(pub);
}

/**
 * Import a caller's public keys. Saves under `keys/callers/<alias>/`.
 * Used by the server to store received caller public keys (e.g., via sync).
 */
export function importCallerPublicKeys(
  alias: string,
  keys: SerializedPublicKeys,
  opts?: KeyManagerOpts,
): void {
  const dir = path.join(callerKeysDir(opts), alias);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Validate the keys are parseable before writing
  deserializePublicKeys(keys);

  fs.writeFileSync(path.join(dir, 'signing.pub.pem'), keys.signing, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'exchange.pub.pem'), keys.exchange, { mode: 0o644 });
}

/**
 * Save server public keys. Writes to `keys/server/`.
 * Used by callboard to store the remote server's public keys (e.g., via sync).
 */
export function saveServerPublicKeys(keys: SerializedPublicKeys, opts?: KeyManagerOpts): void {
  const dir = serverKeysDir(opts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Validate the keys are parseable before writing
  deserializePublicKeys(keys);

  fs.writeFileSync(path.join(dir, 'signing.pub.pem'), keys.signing, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'exchange.pub.pem'), keys.exchange, { mode: 0o644 });
}

/**
 * List all caller aliases (scans `keys/callers/`).
 */
export function listCallers(opts?: KeyManagerOpts): string[] {
  const dir = callerKeysDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        (fs.existsSync(path.join(dir, d.name, 'signing.key.pem')) ||
          fs.existsSync(path.join(dir, d.name, 'signing.pub.pem'))),
    )
    .map((d) => d.name);
}

/**
 * Check if a caller identity exists (has at least public keys).
 */
export function callerExists(alias: string, opts?: KeyManagerOpts): boolean {
  const dir = path.join(callerKeysDir(opts), alias);
  return (
    fs.existsSync(path.join(dir, 'signing.key.pem')) ||
    fs.existsSync(path.join(dir, 'signing.pub.pem'))
  );
}

/**
 * Check if server keys exist.
 */
export function serverExists(opts?: KeyManagerOpts): boolean {
  const dir = serverKeysDir(opts);
  return (
    fs.existsSync(path.join(dir, 'signing.key.pem')) ||
    fs.existsSync(path.join(dir, 'signing.pub.pem'))
  );
}

/**
 * Get the fingerprint of a caller's keys.
 */
export function callerFingerprint(alias: string, opts?: KeyManagerOpts): string {
  const dir = path.join(callerKeysDir(opts), alias);
  // Try full bundle first (has private keys), fall back to public-only
  try {
    const bundle = loadKeyBundle(dir);
    return fingerprint(extractPublicKeys(bundle));
  } catch {
    const pub = loadPublicKeys(dir);
    return fingerprint(pub);
  }
}

/**
 * Get the fingerprint of the server's keys.
 */
export function serverFingerprint(opts?: KeyManagerOpts): string {
  const dir = serverKeysDir(opts);
  // Try full bundle first (has private keys), fall back to public-only
  try {
    const bundle = loadKeyBundle(dir);
    return fingerprint(extractPublicKeys(bundle));
  } catch {
    const pub = loadPublicKeys(dir);
    return fingerprint(pub);
  }
}
