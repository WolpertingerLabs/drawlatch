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
export declare function deriveSessionKeys(sharedSecret: Buffer, isInitiator: boolean, handshakeHash: Buffer): SessionKeys;
/**
 * Encrypted channel for bidirectional communication.
 *
 * Maintains a monotonic counter per direction to prevent replay attacks.
 * Each message includes the counter as AAD (Additional Authenticated Data).
 */
export declare class EncryptedChannel {
    private readonly keys;
    private sendCounter;
    private recvCounter;
    constructor(keys: SessionKeys);
    get sessionId(): string;
    /**
     * Return the underlying session keys (for handshake verification).
     */
    getKeys(): SessionKeys;
    /**
     * Encrypt a message for sending.
     *
     * @returns Buffer containing: IV (12) || authTag (16) || counter (8) || ciphertext
     */
    encrypt(plaintext: Buffer): Buffer;
    /**
     * Decrypt a received message.
     *
     * @throws Error if authentication fails, counter is out of order, or decryption fails
     */
    decrypt(packed: Buffer): Buffer;
    /**
     * Convenience: encrypt a JSON-serializable object.
     */
    encryptJSON(obj: unknown): Buffer;
    /**
     * Convenience: decrypt and parse a JSON object.
     */
    decryptJSON<T = unknown>(packed: Buffer): T;
}
//# sourceMappingURL=channel.d.ts.map