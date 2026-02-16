/**
 * Mutual authentication handshake protocol.
 *
 * Inspired by the Noise NK pattern — the responder's (remote server's) public
 * key is known in advance. The initiator (MCP proxy) proves its identity by
 * signing a challenge, and both sides derive a shared secret via X25519 ECDH.
 *
 * Protocol flow:
 *
 *   Initiator (MCP Proxy)                    Responder (Remote Server)
 *   ──────────────────────                    ────────────────────────
 *
 *   1. Generate ephemeral X25519 keypair
 *      Sign(ephemeral_pub || nonce_i) with Ed25519
 *      ──── HandshakeInit ────────────────►
 *                                             2. Verify initiator's signature
 *                                                Check initiator's pubkey is authorized
 *                                                Generate ephemeral X25519 keypair
 *                                                Sign(ephemeral_pub || nonce_r || nonce_i)
 *                                             ◄──── HandshakeReply ──────
 *   3. Verify responder's signature
 *      Both: ECDH(ephemeral_i, ephemeral_r) → shared secret
 *      Both: HKDF(shared_secret, transcript_hash) → session keys
 *      ──── HandshakeFinish (encrypted "ready") ──►
 *                                             4. Decrypt and verify "ready"
 *                                                Session established ✓
 *
 * The handshake transcript (all messages concatenated) is hashed and used as
 * HKDF salt, binding the session keys to the exact handshake that occurred.
 * This prevents unknown-key-share attacks.
 */
import { type KeyBundle, type PublicKeyBundle, type SessionKeys } from '../crypto/index.js';
export interface HandshakeInit {
    type: 'handshake_init';
    /** Initiator's static Ed25519 public key (PEM) */
    signingPubKey: string;
    /** Initiator's ephemeral X25519 public key (PEM) */
    ephemeralPubKey: string;
    /** Random nonce (32 bytes, hex) */
    nonceI: string;
    /** Ed25519 signature over (ephemeralPubKey || nonceI) */
    signature: string;
    /** Protocol version */
    version: 1;
}
export interface HandshakeReply {
    type: 'handshake_reply';
    /** Responder's ephemeral X25519 public key (PEM) */
    ephemeralPubKey: string;
    /** Random nonce (32 bytes, hex) */
    nonceR: string;
    /** Ed25519 signature over (ephemeralPubKey || nonceR || nonceI) */
    signature: string;
}
export interface HandshakeFinish {
    type: 'handshake_finish';
    /** Encrypted "ready" payload — proves the initiator derived the right keys */
    payload: string;
}
export type HandshakeMessage = HandshakeInit | HandshakeReply | HandshakeFinish;
export declare class HandshakeInitiator {
    /** Our full key bundle */
    private readonly ownKeys;
    /** The remote server's known public keys */
    private readonly peerPublicKeys;
    private ephemeral;
    private nonceI;
    private transcript;
    constructor(
    /** Our full key bundle */
    ownKeys: KeyBundle, 
    /** The remote server's known public keys */
    peerPublicKeys: PublicKeyBundle);
    /**
     * Step 1: Create the initial handshake message.
     */
    createInit(): HandshakeInit;
    /**
     * Step 3: Process the responder's reply and derive session keys.
     */
    processReply(reply: HandshakeReply): SessionKeys;
    /**
     * Create the finish message (encrypted with the newly derived keys).
     */
    createFinish(keys: SessionKeys): HandshakeFinish;
}
export declare class HandshakeResponder {
    /** Our full key bundle */
    private readonly ownKeys;
    /** Set of authorized initiator public keys */
    private readonly authorizedKeys;
    private ephemeral;
    private transcript;
    constructor(
    /** Our full key bundle */
    ownKeys: KeyBundle, 
    /** Set of authorized initiator public keys */
    authorizedKeys: PublicKeyBundle[]);
    /**
     * Step 2: Process the init message, verify the initiator, and create a reply.
     */
    processInit(init: HandshakeInit): {
        reply: HandshakeReply;
        initiatorPubKey: PublicKeyBundle;
    };
    /**
     * Derive session keys after sending the reply.
     * Call this after processInit() and before verifying the finish message.
     */
    deriveKeys(init: HandshakeInit): SessionKeys;
    /**
     * Step 4: Verify the finish message to confirm the initiator derived the right keys.
     */
    verifyFinish(finish: HandshakeFinish, keys: SessionKeys): boolean;
}
//# sourceMappingURL=handshake.d.ts.map