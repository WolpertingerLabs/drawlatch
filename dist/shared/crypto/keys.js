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
import fs from 'node:fs';
import path from 'node:path';
/**
 * Generate a fresh identity with both signing and exchange keypairs.
 */
export function generateKeyBundle() {
    const signing = crypto.generateKeyPairSync('ed25519');
    const exchange = crypto.generateKeyPairSync('x25519');
    return { signing, exchange };
}
/**
 * Extract public keys from a full key bundle.
 */
export function extractPublicKeys(bundle) {
    return {
        signing: bundle.signing.publicKey,
        exchange: bundle.exchange.publicKey,
    };
}
/**
 * Serialize a key bundle to PEM strings for file storage.
 */
export function serializeKeyBundle(bundle) {
    return {
        signing: {
            publicKey: bundle.signing.publicKey.export({ type: 'spki', format: 'pem' }),
            privateKey: bundle.signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        },
        exchange: {
            publicKey: bundle.exchange.publicKey.export({ type: 'spki', format: 'pem' }),
            privateKey: bundle.exchange.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        },
    };
}
/**
 * Deserialize PEM strings back into a key bundle.
 */
export function deserializeKeyBundle(data) {
    return {
        signing: {
            publicKey: crypto.createPublicKey(data.signing.publicKey),
            privateKey: crypto.createPrivateKey(data.signing.privateKey),
        },
        exchange: {
            publicKey: crypto.createPublicKey(data.exchange.publicKey),
            privateKey: crypto.createPrivateKey(data.exchange.privateKey),
        },
    };
}
/**
 * Serialize only public keys.
 */
export function serializePublicKeys(pub) {
    return {
        signing: pub.signing.export({ type: 'spki', format: 'pem' }),
        exchange: pub.exchange.export({ type: 'spki', format: 'pem' }),
    };
}
/**
 * Deserialize public keys from PEM strings.
 */
export function deserializePublicKeys(data) {
    return {
        signing: crypto.createPublicKey(data.signing),
        exchange: crypto.createPublicKey(data.exchange),
    };
}
/**
 * Save a key bundle to a directory with proper file permissions.
 * Creates:
 *   <dir>/signing.pub.pem      (0644)
 *   <dir>/signing.key.pem      (0600)
 *   <dir>/exchange.pub.pem     (0644)
 *   <dir>/exchange.key.pem     (0600)
 */
export function saveKeyBundle(bundle, dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const serialized = serializeKeyBundle(bundle);
    // Public keys — readable
    fs.writeFileSync(path.join(dir, 'signing.pub.pem'), serialized.signing.publicKey, {
        mode: 0o644,
    });
    fs.writeFileSync(path.join(dir, 'exchange.pub.pem'), serialized.exchange.publicKey, {
        mode: 0o644,
    });
    // Private keys — owner-only
    fs.writeFileSync(path.join(dir, 'signing.key.pem'), serialized.signing.privateKey, {
        mode: 0o600,
    });
    fs.writeFileSync(path.join(dir, 'exchange.key.pem'), serialized.exchange.privateKey, {
        mode: 0o600,
    });
}
/**
 * Load a full key bundle from a directory.
 */
export function loadKeyBundle(dir) {
    return deserializeKeyBundle({
        signing: {
            publicKey: fs.readFileSync(path.join(dir, 'signing.pub.pem'), 'utf-8'),
            privateKey: fs.readFileSync(path.join(dir, 'signing.key.pem'), 'utf-8'),
        },
        exchange: {
            publicKey: fs.readFileSync(path.join(dir, 'exchange.pub.pem'), 'utf-8'),
            privateKey: fs.readFileSync(path.join(dir, 'exchange.key.pem'), 'utf-8'),
        },
    });
}
/**
 * Load only public keys from a directory.
 */
export function loadPublicKeys(dir) {
    return deserializePublicKeys({
        signing: fs.readFileSync(path.join(dir, 'signing.pub.pem'), 'utf-8'),
        exchange: fs.readFileSync(path.join(dir, 'exchange.pub.pem'), 'utf-8'),
    });
}
/**
 * Compute a fingerprint of a public key bundle for display/verification.
 * Returns a hex string like "a3:f2:1b:..."
 */
export function fingerprint(pub) {
    const sigRaw = pub.signing.export({ type: 'spki', format: 'der' });
    const exRaw = pub.exchange.export({ type: 'spki', format: 'der' });
    const combined = Buffer.concat([sigRaw, exRaw]);
    const hash = crypto.createHash('sha256').update(combined).digest();
    // Show first 16 bytes as colon-separated hex
    return Array.from(hash.subarray(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(':');
}
//# sourceMappingURL=keys.js.map