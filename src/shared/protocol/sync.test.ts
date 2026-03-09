import { describe, it, expect } from 'vitest';
import {
  generateSyncCode,
  generateSyncEncryptionKey,
  encryptSyncPayload,
  decryptSyncPayload,
  validateSyncRequest,
  isSyncSessionActive,
  DEFAULT_SYNC_TTL_MS,
  type SyncSession,
} from './sync.js';

describe('generateSyncCode', () => {
  it('generates a WORD-NNNN format code', () => {
    const code = generateSyncCode();
    expect(code).toMatch(/^[A-Z]+-\d{4}$/);
  });

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateSyncCode()));
    // With ~76 words * 9000 numbers, collisions in 50 are extremely unlikely
    expect(codes.size).toBe(50);
  });
});

describe('generateSyncEncryptionKey', () => {
  it('generates a 32-byte base64 key', () => {
    const key = generateSyncEncryptionKey();
    const buf = Buffer.from(key, 'base64');
    expect(buf.length).toBe(32);
  });

  it('generates unique keys', () => {
    const a = generateSyncEncryptionKey();
    const b = generateSyncEncryptionKey();
    expect(a).not.toBe(b);
  });
});

describe('encryptSyncPayload / decryptSyncPayload', () => {
  it('round-trips a payload', () => {
    const key = generateSyncEncryptionKey();
    const payload = { hello: 'world', nested: { a: 1 } };

    const encrypted = encryptSyncPayload(payload, key);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('hello'); // should be encrypted

    const decrypted = decryptSyncPayload(encrypted, key);
    expect(decrypted).toEqual(payload);
  });

  it('fails with wrong key', () => {
    const key1 = generateSyncEncryptionKey();
    const key2 = generateSyncEncryptionKey();
    const encrypted = encryptSyncPayload({ data: true }, key1);

    expect(() => decryptSyncPayload(encrypted, key2)).toThrow();
  });

  it('fails with tampered data', () => {
    const key = generateSyncEncryptionKey();
    const encrypted = encryptSyncPayload({ data: true }, key);
    // Flip a byte in the middle
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 5] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decryptSyncPayload(tampered, key)).toThrow();
  });

  it('rejects invalid key length', () => {
    const shortKey = Buffer.alloc(16).toString('base64');
    expect(() => encryptSyncPayload({}, shortKey)).toThrow('32 bytes');
    expect(() => decryptSyncPayload('dGVzdA==', shortKey)).toThrow('32 bytes');
  });

  it('rejects too-short encrypted payload', () => {
    const key = generateSyncEncryptionKey();
    const tooShort = Buffer.alloc(20).toString('base64');
    expect(() => decryptSyncPayload(tooShort, key)).toThrow('too short');
  });
});

describe('validateSyncRequest', () => {
  const validRequest = {
    inviteCode: 'WOLF-1234',
    confirmCode: 'BEAR-5678',
    callerAlias: 'my-callboard',
    publicKeys: {
      signing: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      exchange: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
    },
  };

  it('returns null for valid request', () => {
    expect(validateSyncRequest(validRequest)).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateSyncRequest('string')).toBe('payload must be an object');
    expect(validateSyncRequest(null)).toBe('payload must be an object');
  });

  it('rejects missing inviteCode', () => {
    const { inviteCode: _inviteCode, ...rest } = validRequest;
    expect(validateSyncRequest(rest)).toBe('missing or invalid inviteCode');
  });

  it('rejects missing confirmCode', () => {
    const { confirmCode: _confirmCode, ...rest } = validRequest;
    expect(validateSyncRequest(rest)).toBe('missing or invalid confirmCode');
  });

  it('rejects missing callerAlias', () => {
    const { callerAlias: _callerAlias, ...rest } = validRequest;
    expect(validateSyncRequest(rest)).toBe('missing or invalid callerAlias');
  });

  it('rejects missing publicKeys', () => {
    const { publicKeys: _publicKeys, ...rest } = validRequest;
    expect(validateSyncRequest(rest)).toBe('missing publicKeys');
  });

  it('rejects missing publicKeys.signing', () => {
    expect(validateSyncRequest({ ...validRequest, publicKeys: { exchange: 'x' } })).toBe(
      'missing publicKeys.signing',
    );
  });

  it('rejects missing publicKeys.exchange', () => {
    expect(validateSyncRequest({ ...validRequest, publicKeys: { signing: 'x' } })).toBe(
      'missing publicKeys.exchange',
    );
  });
});

describe('isSyncSessionActive', () => {
  function makeSession(overrides: Partial<SyncSession> = {}): SyncSession {
    return {
      inviteCode: 'TEST-0000',
      confirmCode: null,
      encryptionKey: 'dGVzdA==',
      createdAt: Date.now(),
      ttlMs: DEFAULT_SYNC_TTL_MS,
      completed: false,
      failedAttempts: 0,
      ...overrides,
    };
  }

  it('returns true for fresh session', () => {
    expect(isSyncSessionActive(makeSession())).toBe(true);
  });

  it('returns false for completed session', () => {
    expect(isSyncSessionActive(makeSession({ completed: true }))).toBe(false);
  });

  it('returns false for expired session', () => {
    expect(
      isSyncSessionActive(makeSession({ createdAt: Date.now() - DEFAULT_SYNC_TTL_MS - 1000 })),
    ).toBe(false);
  });
});
