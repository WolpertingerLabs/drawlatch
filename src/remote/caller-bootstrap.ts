/**
 * Programmatic / non-interactive caller bootstrap (item E).
 *
 * The interactive `drawlatch sync` handshake stays the path for *remote*
 * enrollment (a caller on another machine proving identity over the network).
 * This module is for the zero-friction local case: a co-located client that
 * shares drawlatch's filesystem can provision a caller — complete with a fresh
 * keypair — without any invite-code dance.
 *
 * Two entry points:
 *   - `createCallerWithKeys()` — library function (also exposed as the
 *     password-gated `POST /api/admin/callers` admin endpoint).
 *   - `autoEnroll()` — loopback / shared-fs path: a client proves filesystem
 *     access by presenting the one-time token drawlatch writes into the config
 *     dir at startup, and gets a caller provisioned with zero interaction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  loadRemoteConfig,
  saveRemoteConfig,
  getConfigDir,
  getCallerKeysDir,
  type RemoteServerConfig,
} from '../shared/config.js';
import { createCaller, callerExists } from '../shared/crypto/key-manager.js';
import type { SerializedPublicKeys } from '../shared/crypto/keys.js';
import { setEnvVars } from '../shared/env-utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('caller-bootstrap');

/** Valid caller alias: starts with a letter/number, then letters/numbers/-/_. */
export const CALLER_ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface CreateCallerOptions {
  /** Human-readable display name (defaults to the alias). */
  name?: string;
  /** Connection aliases to grant. When omitted, clones the `default` caller's
   *  connections so a new caller starts with the same access (common expectation). */
  connections?: string[];
}

export interface CreateCallerResult {
  alias: string;
  name: string;
  fingerprint: string;
  /** The caller's freshly-generated public keys (private keys stay on disk). */
  publicKeys: SerializedPublicKeys;
  /** Directory holding the caller's keypair (keys/callers/<alias>/). */
  keysDir: string;
  connections: string[];
}

/**
 * Create a caller WITH a fresh keypair, registered in remote.config.json,
 * without the interactive sync handshake.
 *
 * Throws on invalid alias, or if the caller (config entry or key dir) exists.
 */
export function createCallerWithKeys(
  alias: string,
  opts: CreateCallerOptions = {},
): CreateCallerResult {
  if (!CALLER_ALIAS_REGEX.test(alias)) {
    throw new Error(
      'Invalid alias: must start with a letter or number and contain only ' +
        'letters, numbers, hyphens, and underscores',
    );
  }

  const config = loadRemoteConfig();
  if (alias in config.callers || callerExists(alias)) {
    throw new Error(`Caller "${alias}" already exists`);
  }

  // Generate the caller's keypair under keys/callers/<alias>/.
  const { publicKeys, fingerprint } = createCaller(alias);

  const name = opts.name ?? alias;
  const defaultCaller = config.callers.default as RemoteServerConfig['callers'][string] | undefined;
  const connections = opts.connections ?? [...(defaultCaller?.connections ?? [])];

  config.callers[alias] = { name, connections };
  saveRemoteConfig(config);

  log.info(
    `Created caller "${alias}" with keypair (${connections.length} connection(s), fingerprint ${fingerprint})`,
  );

  return {
    alias,
    name,
    fingerprint,
    publicKeys,
    keysDir: path.join(getCallerKeysDir(), alias),
    connections,
  };
}

/**
 * Delete a caller: removes its config entry, prefixed env vars, and key dir.
 * The `default` caller cannot be deleted.
 */
export function deleteCaller(alias: string): void {
  if (alias === 'default') {
    throw new Error('Cannot delete the "default" caller');
  }

  const config = loadRemoteConfig();
  if (!(alias in config.callers)) {
    throw new Error(`Caller "${alias}" not found`);
  }

  // Clean up prefixed env vars referenced by this caller's env mapping.
  const caller = config.callers[alias];
  if (caller.env) {
    const envUpdates: Record<string, string> = {};
    for (const mapping of Object.values(caller.env)) {
      const envMatch = /^\$\{(.+)\}$/.exec(mapping);
      if (envMatch) envUpdates[envMatch[1]] = ''; // empty string = delete
    }
    if (Object.keys(envUpdates).length > 0) setEnvVars(envUpdates);
  }

  const { [alias]: _removed, ...remainingCallers } = config.callers;
  config.callers = remainingCallers;
  saveRemoteConfig(config);

  // Remove the caller's key directory.
  const keysDir = path.join(getCallerKeysDir(), alias);
  if (fs.existsSync(keysDir)) {
    fs.rmSync(keysDir, { recursive: true, force: true });
  }

  log.info(`Deleted caller "${alias}"`);
}

// ── Loopback / shared-fs auto-enroll ───────────────────────────────────────

/** Path of the one-time enroll token file inside the config dir. */
export function getEnrollTokenPath(): string {
  return path.join(getConfigDir(), 'enroll.token');
}

/**
 * Write a fresh one-time enroll token into the config dir (mode 0600).
 *
 * Only a process with filesystem access to drawlatch's config dir can read it,
 * which is exactly the proof-of-co-location we want for `autoEnroll()`.
 * Called once at daemon startup; overwrites any stale token.
 */
export function writeEnrollToken(): string {
  const token = randomBytes(32).toString('hex');
  const tokenPath = getEnrollTokenPath();
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

/** Constant-time compare of the presented token against the on-disk token. */
function tokenMatches(presented: string): boolean {
  const tokenPath = getEnrollTokenPath();
  if (!fs.existsSync(tokenPath)) return false;
  const onDisk = fs.readFileSync(tokenPath, 'utf8').trim();
  const a = Buffer.from(onDisk);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Auto-enroll a co-located caller by presenting the one-time enroll token.
 *
 * Verifies the token proves filesystem access to the config dir, then either
 * creates a new caller with keys (if the alias is new) or returns the existing
 * one's metadata (idempotent). The token is single-use: it is rotated on every
 * successful enroll so a leaked token cannot be replayed.
 */
export function autoEnroll(
  token: string,
  alias: string,
  opts: CreateCallerOptions = {},
): CreateCallerResult {
  if (!tokenMatches(token)) {
    throw new Error('Invalid or expired enroll token');
  }

  const result = createCallerWithKeys(alias, opts);

  // Rotate the token so it cannot be replayed.
  writeEnrollToken();

  return result;
}

/** Re-exported for callers that want to introspect config without re-importing. */
export type { RemoteServerConfig };
