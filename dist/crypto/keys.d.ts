/**
 * Key generation and management.
 *
 * Two key pairs per identity:
 *   - Ed25519 (signing) — proves identity, signs handshake messages
 *   - X25519 (key exchange) — derives shared encryption keys via ECDH
 *
 * All keys are serialized as PEM for storage and raw buffers for wire use.
 * Zero external crypto dependencies — uses only Node.js native crypto.
 */
import crypto from 'node:crypto';
/** A full identity keypair bundle */
export interface KeyBundle {
    /** Ed25519 signing keypair */
    signing: {
        publicKey: crypto.KeyObject;
        privateKey: crypto.KeyObject;
    };
    /** X25519 key exchange keypair */
    exchange: {
        publicKey: crypto.KeyObject;
        privateKey: crypto.KeyObject;
    };
}
/** Serialized key bundle for storage */
export interface SerializedKeyBundle {
    signing: {
        publicKey: string;
        privateKey: string;
    };
    exchange: {
        publicKey: string;
        privateKey: string;
    };
}
/** Public-only key bundle (safe to share) */
export interface PublicKeyBundle {
    signing: crypto.KeyObject;
    exchange: crypto.KeyObject;
}
/** Serialized public keys for storage/transmission */
export interface SerializedPublicKeys {
    signing: string;
    exchange: string;
}
/**
 * Generate a fresh identity with both signing and exchange keypairs.
 */
export declare function generateKeyBundle(): KeyBundle;
/**
 * Extract public keys from a full key bundle.
 */
export declare function extractPublicKeys(bundle: KeyBundle): PublicKeyBundle;
/**
 * Serialize a key bundle to PEM strings for file storage.
 */
export declare function serializeKeyBundle(bundle: KeyBundle): SerializedKeyBundle;
/**
 * Deserialize PEM strings back into a key bundle.
 */
export declare function deserializeKeyBundle(data: SerializedKeyBundle): KeyBundle;
/**
 * Serialize only public keys.
 */
export declare function serializePublicKeys(pub: PublicKeyBundle): SerializedPublicKeys;
/**
 * Deserialize public keys from PEM strings.
 */
export declare function deserializePublicKeys(data: SerializedPublicKeys): PublicKeyBundle;
/**
 * Save a key bundle to a directory with proper file permissions.
 * Creates:
 *   <dir>/signing.pub.pem      (0644)
 *   <dir>/signing.key.pem      (0600)
 *   <dir>/exchange.pub.pem     (0644)
 *   <dir>/exchange.key.pem     (0600)
 */
export declare function saveKeyBundle(bundle: KeyBundle, dir: string): void;
/**
 * Load a full key bundle from a directory.
 */
export declare function loadKeyBundle(dir: string): KeyBundle;
/**
 * Load only public keys from a directory.
 */
export declare function loadPublicKeys(dir: string): PublicKeyBundle;
/**
 * Compute a fingerprint of a public key bundle for display/verification.
 * Returns a hex string like "a3:f2:1b:..."
 */
export declare function fingerprint(pub: PublicKeyBundle): string;
//# sourceMappingURL=keys.d.ts.map