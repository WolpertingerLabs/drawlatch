import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { deriveSessionKeys, EncryptedChannel, type SessionKeys } from './channel.js';

/** Create a matching pair of session keys (initiator + responder) */
function createKeyPair(): { initiatorKeys: SessionKeys; responderKeys: SessionKeys } {
  const sharedSecret = crypto.randomBytes(32);
  const handshakeHash = crypto.randomBytes(32);

  const initiatorKeys = deriveSessionKeys(sharedSecret, true, handshakeHash);
  const responderKeys = deriveSessionKeys(sharedSecret, false, handshakeHash);

  return { initiatorKeys, responderKeys };
}

describe('deriveSessionKeys', () => {
  it('should derive session keys with sendKey, recvKey, and sessionId', () => {
    const sharedSecret = crypto.randomBytes(32);
    const handshakeHash = crypto.randomBytes(32);
    const keys = deriveSessionKeys(sharedSecret, true, handshakeHash);

    expect(keys.sendKey).toBeDefined();
    expect(keys.sendKey.encryptionKey).toBeInstanceOf(Buffer);
    expect(keys.sendKey.encryptionKey).toHaveLength(32);

    expect(keys.recvKey).toBeDefined();
    expect(keys.recvKey.encryptionKey).toBeInstanceOf(Buffer);
    expect(keys.recvKey.encryptionKey).toHaveLength(32);

    expect(keys.sessionId).toBeDefined();
    expect(typeof keys.sessionId).toBe('string');
    expect(keys.sessionId).toHaveLength(32); // 16 bytes hex = 32 chars
  });

  it('should derive different send and recv keys', () => {
    const sharedSecret = crypto.randomBytes(32);
    const handshakeHash = crypto.randomBytes(32);
    const keys = deriveSessionKeys(sharedSecret, true, handshakeHash);

    expect(keys.sendKey.encryptionKey.equals(keys.recvKey.encryptionKey)).toBe(false);
  });

  it('should produce complementary keys for initiator and responder', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();

    // Initiator's sendKey should equal responder's recvKey (and vice versa)
    expect(initiatorKeys.sendKey.encryptionKey.equals(responderKeys.recvKey.encryptionKey)).toBe(
      true,
    );
    expect(initiatorKeys.recvKey.encryptionKey.equals(responderKeys.sendKey.encryptionKey)).toBe(
      true,
    );
  });

  it('should produce the same sessionId for both sides', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    expect(initiatorKeys.sessionId).toBe(responderKeys.sessionId);
  });

  it('should produce different keys for different shared secrets', () => {
    const hash = crypto.randomBytes(32);
    const keys1 = deriveSessionKeys(crypto.randomBytes(32), true, hash);
    const keys2 = deriveSessionKeys(crypto.randomBytes(32), true, hash);

    expect(keys1.sendKey.encryptionKey.equals(keys2.sendKey.encryptionKey)).toBe(false);
    expect(keys1.sessionId).not.toBe(keys2.sessionId);
  });

  it('should produce different keys for different handshake hashes', () => {
    const secret = crypto.randomBytes(32);
    const keys1 = deriveSessionKeys(secret, true, crypto.randomBytes(32));
    const keys2 = deriveSessionKeys(secret, true, crypto.randomBytes(32));

    expect(keys1.sendKey.encryptionKey.equals(keys2.sendKey.encryptionKey)).toBe(false);
  });
});

describe('EncryptedChannel', () => {
  it('should encrypt and decrypt a message between paired channels', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const plaintext = Buffer.from('hello, encrypted world!');
    const encrypted = initiator.encrypt(plaintext);
    const decrypted = responder.decrypt(encrypted);

    expect(decrypted.toString()).toBe('hello, encrypted world!');
  });

  it('should support bidirectional communication', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    // initiator -> responder
    const msg1 = Buffer.from('from initiator');
    const enc1 = initiator.encrypt(msg1);
    expect(responder.decrypt(enc1).toString()).toBe('from initiator');

    // responder -> initiator
    const msg2 = Buffer.from('from responder');
    const enc2 = responder.encrypt(msg2);
    expect(initiator.decrypt(enc2).toString()).toBe('from responder');
  });

  it('should expose sessionId', () => {
    const { initiatorKeys } = createKeyPair();
    const channel = new EncryptedChannel(initiatorKeys);
    expect(channel.sessionId).toBe(initiatorKeys.sessionId);
  });

  it('should expose underlying keys via getKeys()', () => {
    const { initiatorKeys } = createKeyPair();
    const channel = new EncryptedChannel(initiatorKeys);
    expect(channel.getKeys()).toBe(initiatorKeys);
  });

  it('should encrypt multiple messages with incrementing counters', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    for (let i = 0; i < 10; i++) {
      const msg = Buffer.from(`message ${i}`);
      const encrypted = initiator.encrypt(msg);
      const decrypted = responder.decrypt(encrypted);
      expect(decrypted.toString()).toBe(`message ${i}`);
    }
  });

  it('should reject messages with wrong counter (replay attack)', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const msg1 = initiator.encrypt(Buffer.from('first'));
    const _msg2 = initiator.encrypt(Buffer.from('second'));

    // Decrypt first message
    responder.decrypt(msg1);

    // Try to replay first message instead of second — counter mismatch
    expect(() => responder.decrypt(msg1)).toThrow('Counter mismatch');
  });

  it('should reject out-of-order messages', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const _msg1 = initiator.encrypt(Buffer.from('first'));
    const msg2 = initiator.encrypt(Buffer.from('second'));

    // Skip msg1, try msg2 directly — counter expects 0 but gets 1
    expect(() => responder.decrypt(msg2)).toThrow('Counter mismatch');
  });

  it('should reject tampered messages', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const encrypted = initiator.encrypt(Buffer.from('sensitive data'));

    // Tamper with the ciphertext (last byte)
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => responder.decrypt(tampered)).toThrow();
  });

  it('should reject messages that are too short', () => {
    const { responderKeys } = createKeyPair();
    const responder = new EncryptedChannel(responderKeys);

    // Minimum is IV(12) + AuthTag(16) + Counter(8) = 36 bytes
    const tooShort = Buffer.alloc(35);
    expect(() => responder.decrypt(tooShort)).toThrow('Message too short');
  });

  it('should reject messages encrypted with wrong key', () => {
    const pair1 = createKeyPair();
    const pair2 = createKeyPair();

    const sender = new EncryptedChannel(pair1.initiatorKeys);
    const wrongReceiver = new EncryptedChannel(pair2.responderKeys);

    const encrypted = sender.encrypt(Buffer.from('secret'));
    expect(() => wrongReceiver.decrypt(encrypted)).toThrow();
  });

  describe('encryptJSON / decryptJSON', () => {
    it('should round-trip JSON objects', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const obj = { type: 'test', data: [1, 2, 3], nested: { key: 'value' } };
      const encrypted = initiator.encryptJSON(obj);
      const decrypted = responder.decryptJSON(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should handle string values', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encrypted = initiator.encryptJSON('just a string');
      const decrypted = responder.decryptJSON(encrypted);

      expect(decrypted).toBe('just a string');
    });

    it('should handle null and numbers', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encNull = initiator.encryptJSON(null);
      expect(responder.decryptJSON(encNull)).toBeNull();

      const encNum = initiator.encryptJSON(42);
      expect(responder.decryptJSON(encNum)).toBe(42);
    });

    it('should handle empty objects and arrays', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encObj = initiator.encryptJSON({});
      expect(responder.decryptJSON(encObj)).toEqual({});

      const encArr = initiator.encryptJSON([]);
      expect(responder.decryptJSON(encArr)).toEqual([]);
    });
  });
});
