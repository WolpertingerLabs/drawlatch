/**
 * High-level key management API.
 *
 * Provides CRUD operations over the drawlatch key directory structure
 * so that callboard (and other consumers) can manage keys programmatically
 * without touching the filesystem directly.
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
import { getLocalKeysDir, getPeerKeysDir, getRemoteKeysDir, getConfigDir } from '../config.js';

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

function localKeysDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return path.join(opts.configDir, 'keys', 'local');
  return getLocalKeysDir();
}

function remoteKeysDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return path.join(opts.configDir, 'keys', 'remote');
  return getRemoteKeysDir();
}

function peerKeysDir(opts?: KeyManagerOpts): string {
  if (opts?.configDir) return path.join(opts.configDir, 'keys', 'peers');
  return getPeerKeysDir();
}

/**
 * Create a new caller identity (Ed25519 + X25519 keypairs).
 * Saves under `keys/local/<alias>/`.
 * Throws if the alias already exists.
 */
export function createCaller(alias: string, opts?: KeyManagerOpts): CreateCallerResult {
  const dir = path.join(localKeysDir(opts), alias);
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
 * Export public keys for a local identity or the remote server.
 *
 * - type 'local': reads from `keys/local/<alias>/` (alias defaults to 'default')
 * - type 'remote': reads from `keys/remote/`
 */
export function exportPublicKeys(
  type: 'local' | 'remote',
  alias?: string,
  opts?: KeyManagerOpts,
): SerializedPublicKeys {
  let dir: string;
  if (type === 'local') {
    dir = path.join(localKeysDir(opts), alias ?? 'default');
  } else {
    dir = remoteKeysDir(opts);
  }
  const pub = loadPublicKeys(dir);
  return serializePublicKeys(pub);
}

/**
 * Import a peer's public keys. Saves under `keys/peers/<alias>/`.
 */
export function importPeerPublicKeys(
  alias: string,
  keys: SerializedPublicKeys,
  opts?: KeyManagerOpts,
): void {
  const dir = path.join(peerKeysDir(opts), alias);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Validate the keys are parseable before writing
  deserializePublicKeys(keys);

  fs.writeFileSync(path.join(dir, 'signing.pub.pem'), keys.signing, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'exchange.pub.pem'), keys.exchange, { mode: 0o644 });
}

/**
 * Export a peer's previously-imported public keys.
 */
export function exportPeerPublicKeys(alias: string, opts?: KeyManagerOpts): SerializedPublicKeys {
  const dir = path.join(peerKeysDir(opts), alias);
  const pub = loadPublicKeys(dir);
  return serializePublicKeys(pub);
}

/**
 * Save public keys from a remote server (shorthand for `importPeerPublicKeys('remote-server', ...)`).
 */
export function saveRemotePublicKeys(
  keys: SerializedPublicKeys,
  opts?: KeyManagerOpts,
): void {
  importPeerPublicKeys('remote-server', keys, opts);
}

/**
 * List all local caller aliases.
 */
export function listCallers(opts?: KeyManagerOpts): string[] {
  const dir = localKeysDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'signing.key.pem')))
    .map((d) => d.name);
}

/**
 * List all imported peer aliases.
 */
export function listPeers(opts?: KeyManagerOpts): string[] {
  const dir = peerKeysDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'signing.pub.pem')))
    .map((d) => d.name);
}

/**
 * Check if a local caller identity exists.
 */
export function callerExists(alias: string, opts?: KeyManagerOpts): boolean {
  return fs.existsSync(path.join(localKeysDir(opts), alias, 'signing.key.pem'));
}

/**
 * Check if a peer's keys have been imported.
 */
export function peerExists(alias: string, opts?: KeyManagerOpts): boolean {
  return fs.existsSync(path.join(peerKeysDir(opts), alias, 'signing.pub.pem'));
}

/**
 * Get the fingerprint of a local caller's keys.
 */
export function callerFingerprint(alias: string, opts?: KeyManagerOpts): string {
  const dir = path.join(localKeysDir(opts), alias);
  const bundle = loadKeyBundle(dir);
  return fingerprint(extractPublicKeys(bundle));
}

/**
 * Get the fingerprint of a peer's imported public keys.
 */
export function peerFingerprint(alias: string, opts?: KeyManagerOpts): string {
  const dir = path.join(peerKeysDir(opts), alias);
  const pub = loadPublicKeys(dir);
  return fingerprint(pub);
}
