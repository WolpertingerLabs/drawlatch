/**
 * Encrypted communication channel using AES-256-GCM.
 *
 * After the handshake, both sides derive directional keys:
 *   - initiator→responder key (for messages from the MCP proxy to the remote server)
 *   - responder→initiator key (for messages from the remote server back)
 *
 * Each message is encrypted with a fresh random IV and includes:
 *   - 12-byte IV
 *   - 16-byte GCM auth tag
 *   - ciphertext
 *   - monotonic counter as AAD (prevents replay/reorder)
 *
 * The shared secret from X25519 ECDH is never used directly — HKDF derives
 * separate encryption keys for each direction plus a MAC key.
 */

import crypto from 'node:crypto';

/** Wire format: IV (12) + authTag (16) + counter (8) + ciphertext (variable) */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const COUNTER_LENGTH = 8; // uint64 big-endian

/** Derived session keys for one direction */
export interface DirectionalKey {
  /** AES-256-GCM encryption key (32 bytes) */
  encryptionKey: Buffer;
}

/** Full session keys for bidirectional communication */
export interface SessionKeys {
  /** Key for initiator → responder messages */
  sendKey: DirectionalKey;
  /** Key for responder → initiator messages */
  recvKey: DirectionalKey;
  /** Shared session ID for logging/correlation */
  sessionId: string;
}

/**
 * Derive bidirectional session keys from the X25519 shared secret.
 *
 * Uses HKDF-SHA256 with a role-aware info string so each direction
 * gets a unique key even from the same shared secret.
 *
 * @param sharedSecret - Raw X25519 ECDH output (32 bytes)
 * @param isInitiator - Whether this side initiated the handshake
 * @param handshakeHash - Hash of the handshake transcript (binds keys to this session)
 */
export function deriveSessionKeys(
  sharedSecret: Buffer,
  isInitiator: boolean,
  handshakeHash: Buffer,
): SessionKeys {
  // Use handshake transcript hash as salt — binds keys to this specific session
  const salt = handshakeHash;

  // Derive initiator→responder key
  const i2rKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, 'initiator-to-responder', 32),
  );

  // Derive responder→initiator key
  const r2iKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, 'responder-to-initiator', 32),
  );

  // Derive session ID for logging
  const sessionIdBuf = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, 'session-id', 16));
  const sessionId = sessionIdBuf.toString('hex');

  return {
    sendKey: { encryptionKey: isInitiator ? i2rKey : r2iKey },
    recvKey: { encryptionKey: isInitiator ? r2iKey : i2rKey },
    sessionId,
  };
}

/**
 * Encrypted channel for bidirectional communication.
 *
 * Maintains a monotonic counter per direction to prevent replay attacks.
 * Each message includes the counter as AAD (Additional Authenticated Data).
 */
export class EncryptedChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;

  constructor(private readonly keys: SessionKeys) {}

  get sessionId(): string {
    return this.keys.sessionId;
  }

  /**
   * Return the underlying session keys (for handshake verification).
   */
  getKeys(): SessionKeys {
    return this.keys;
  }

  /**
   * Encrypt a message for sending.
   *
   * @returns Buffer containing: IV (12) || authTag (16) || counter (8) || ciphertext
   */
  encrypt(plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const counter = this.sendCounter++;

    // Encode counter as big-endian uint64 for AAD
    const counterBuf = Buffer.alloc(COUNTER_LENGTH);
    counterBuf.writeBigUInt64BE(counter);

    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.sendKey.encryptionKey, iv);
    cipher.setAAD(counterBuf);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Pack: IV || authTag || counter || ciphertext
    return Buffer.concat([iv, authTag, counterBuf, encrypted]);
  }

  /**
   * Decrypt a received message.
   *
   * @throws Error if authentication fails, counter is out of order, or decryption fails
   */
  decrypt(packed: Buffer): Buffer {
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH) {
      throw new Error('Message too short');
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const counterBuf = packed.subarray(
      IV_LENGTH + AUTH_TAG_LENGTH,
      IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH,
    );
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH + COUNTER_LENGTH);

    // Verify counter is strictly monotonic
    const counter = counterBuf.readBigUInt64BE();
    if (counter !== this.recvCounter) {
      throw new Error(
        `Counter mismatch: expected ${this.recvCounter}, got ${counter}. ` +
          'Possible replay or reordering attack.',
      );
    }
    this.recvCounter++;

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.keys.recvKey.encryptionKey, iv);
    decipher.setAAD(counterBuf);
    decipher.setAuthTag(authTag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Decryption failed: authentication tag mismatch (tampered or wrong key)');
    }
  }

  /**
   * Convenience: encrypt a JSON-serializable object.
   */
  encryptJSON(obj: unknown): Buffer {
    return this.encrypt(Buffer.from(JSON.stringify(obj), 'utf-8'));
  }

  /**
   * Convenience: decrypt and parse a JSON object.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is used by callers for type narrowing of the return value
  decryptJSON<T = unknown>(packed: Buffer): T {
    const plaintext = this.decrypt(packed);
    return JSON.parse(plaintext.toString('utf-8')) as T;
  }
}
