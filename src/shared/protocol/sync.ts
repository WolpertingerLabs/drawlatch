/**
 * Sync protocol — types, code generation, and encryption helpers.
 *
 * Used by both the drawlatch remote server and the callboard sync client
 * to coordinate a double-code key exchange with AES-256-GCM encryption.
 */

import crypto from 'node:crypto';
import type { SerializedPublicKeys } from '../crypto/keys.js';

// ── Sync codes ───────────────────────────────────────────────────────────────

const SYNC_WORDS = [
  'ALPHA',
  'ARROW',
  'ATLAS',
  'BIRCH',
  'BLADE',
  'BLAZE',
  'BLOOM',
  'BRAVE',
  'BRISK',
  'CEDAR',
  'CHALK',
  'CLIFF',
  'CORAL',
  'CRANE',
  'CREST',
  'CROWN',
  'DELTA',
  'DRIFT',
  'EAGLE',
  'EMBER',
  'FABLE',
  'FLAME',
  'FLINT',
  'FORGE',
  'FROST',
  'GLEAM',
  'GLOBE',
  'GRAIN',
  'GROVE',
  'HAVEN',
  'HAZEL',
  'HERON',
  'IVORY',
  'JEWEL',
  'LANCE',
  'LARCH',
  'LIGHT',
  'LINEN',
  'MAPLE',
  'MARSH',
  'NORTH',
  'OCEAN',
  'OLIVE',
  'ONYX',
  'ORBIT',
  'PEARL',
  'PETAL',
  'PIXEL',
  'PLUME',
  'PRISM',
  'QUAIL',
  'QUEST',
  'RAVEN',
  'RIDGE',
  'RIVER',
  'ROWAN',
  'SABLE',
  'SHADE',
  'SLATE',
  'SOLAR',
  'SPARK',
  'SPIRE',
  'STEEL',
  'STONE',
  'STORM',
  'SWIFT',
  'THORN',
  'TIGER',
  'TORCH',
  'TRAIL',
  'VAPOR',
  'VIVID',
  'WHALE',
  'WREN',
  'WOLF',
  'ZENITH',
];

/**
 * Generate a human-readable sync code: WORD-NNNN (e.g., "WOLF-3847").
 */
export function generateSyncCode(): string {
  const word = SYNC_WORDS[crypto.randomInt(SYNC_WORDS.length)];
  const num = crypto.randomInt(1000, 10000); // 4-digit number
  return `${word}-${num}`;
}

// ── Encryption key ───────────────────────────────────────────────────────────

/**
 * Generate a one-time AES-256-GCM key for encrypting the sync exchange.
 * Returns a base64-encoded 32-byte key.
 */
export function generateSyncEncryptionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

// ── Payload encryption ───────────────────────────────────────────────────────

/**
 * Encrypt a JSON-serializable payload with AES-256-GCM.
 *
 * Wire format: base64(IV[12] || authTag[16] || ciphertext)
 */
export function encryptSyncPayload(payload: object, encryptionKey: string): string {
  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (base64-encoded)');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt an AES-256-GCM encrypted payload back to a parsed object.
 *
 * Throws on decryption failure (wrong key, tampered data, etc.).
 */
export function decryptSyncPayload(encrypted: string, encryptionKey: string): unknown {
  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (base64-encoded)');

  const data = Buffer.from(encrypted, 'base64');
  if (data.length < 28) throw new Error('Encrypted payload too short');

  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Sent by callboard to drawlatch (encrypted with sync encryption key). */
export interface SyncRequest {
  inviteCode: string;
  confirmCode: string;
  callerAlias: string;
  publicKeys: SerializedPublicKeys;
}

/** Returned by drawlatch to callboard (encrypted with sync encryption key). */
export interface SyncResponse {
  remotePublicKeys: SerializedPublicKeys;
  callerAlias: string;
  fingerprint: string;
}

/** Maximum number of failed sync code attempts before session invalidation. */
export const MAX_SYNC_ATTEMPTS = 5;

/** Server-side sync session state. */
export interface SyncSession {
  inviteCode: string;
  confirmCode: string | null;
  encryptionKey: string;
  createdAt: number;
  ttlMs: number;
  completed: boolean;
  /** Number of failed code-match attempts (session invalidated at MAX_SYNC_ATTEMPTS). */
  failedAttempts: number;
  /** Populated after successful sync. */
  result?: {
    callerAlias: string;
    fingerprint: string;
  };
}

export type SyncErrorCode =
  | 'NO_ACTIVE_SESSION'
  | 'CODE_MISMATCH'
  | 'SESSION_EXPIRED'
  | 'ALREADY_COMPLETED'
  | 'DECRYPTION_FAILED'
  | 'INVALID_PAYLOAD';

export const DEFAULT_SYNC_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check whether a sync session is still valid (not expired and not completed).
 */
export function isSyncSessionActive(session: SyncSession): boolean {
  if (session.completed) return false;
  if (Date.now() - session.createdAt > session.ttlMs) return false;
  return true;
}

/**
 * Validate a SyncRequest shape (after decryption).
 * Returns null if valid, or an error message string.
 */
export function validateSyncRequest(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return 'payload must be an object';
  const obj = data as Record<string, unknown>;
  if (typeof obj.inviteCode !== 'string') return 'missing or invalid inviteCode';
  if (typeof obj.confirmCode !== 'string') return 'missing or invalid confirmCode';
  if (typeof obj.callerAlias !== 'string') return 'missing or invalid callerAlias';
  if (typeof obj.publicKeys !== 'object' || obj.publicKeys === null) return 'missing publicKeys';
  const keys = obj.publicKeys as Record<string, unknown>;
  if (typeof keys.signing !== 'string') return 'missing publicKeys.signing';
  if (typeof keys.exchange !== 'string') return 'missing publicKeys.exchange';
  return null;
}
