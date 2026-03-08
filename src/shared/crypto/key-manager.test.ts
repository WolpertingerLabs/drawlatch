import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCaller,
  exportCallerPublicKeys,
  exportServerPublicKeys,
  importCallerPublicKeys,
  saveServerPublicKeys,
  listCallers,
  callerExists,
  serverExists,
  callerFingerprint,
  serverFingerprint,
} from './key-manager.js';
import {
  generateKeyBundle,
  saveKeyBundle,
  extractPublicKeys,
  serializePublicKeys,
} from './keys.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-manager-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createCaller', () => {
  it('creates a new caller with keypairs', () => {
    const result = createCaller('test-caller', { configDir: tmpDir });
    expect(result.publicKeys.signing).toContain('PUBLIC KEY');
    expect(result.publicKeys.exchange).toContain('PUBLIC KEY');
    expect(result.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);

    // Verify files exist
    const keyDir = path.join(tmpDir, 'keys', 'callers', 'test-caller');
    expect(fs.existsSync(path.join(keyDir, 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keyDir, 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keyDir, 'exchange.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keyDir, 'exchange.key.pem'))).toBe(true);
  });

  it('throws if alias already exists', () => {
    createCaller('dup', { configDir: tmpDir });
    expect(() => createCaller('dup', { configDir: tmpDir })).toThrow('already exists');
  });
});

describe('exportCallerPublicKeys', () => {
  it('exports caller public keys', () => {
    const created = createCaller('export-test', { configDir: tmpDir });
    const exported = exportCallerPublicKeys('export-test', { configDir: tmpDir });
    expect(exported.signing).toBe(created.publicKeys.signing);
    expect(exported.exchange).toBe(created.publicKeys.exchange);
  });
});

describe('exportServerPublicKeys', () => {
  it('exports server public keys', () => {
    const serverDir = path.join(tmpDir, 'keys', 'server');
    const bundle = generateKeyBundle();
    saveKeyBundle(bundle, serverDir);

    const exported = exportServerPublicKeys({ configDir: tmpDir });
    expect(exported.signing).toContain('PUBLIC KEY');
    expect(exported.exchange).toContain('PUBLIC KEY');
  });
});

describe('importCallerPublicKeys', () => {
  it('round-trips caller public keys', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));

    importCallerPublicKeys('my-caller', pub, { configDir: tmpDir });
    const exported = exportCallerPublicKeys('my-caller', { configDir: tmpDir });

    expect(exported.signing).toBe(pub.signing);
    expect(exported.exchange).toBe(pub.exchange);
  });
});

describe('saveServerPublicKeys', () => {
  it('saves under keys/server/', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));

    saveServerPublicKeys(pub, { configDir: tmpDir });
    expect(serverExists({ configDir: tmpDir })).toBe(true);
  });
});

describe('listCallers', () => {
  it('lists created callers', () => {
    expect(listCallers({ configDir: tmpDir })).toEqual([]);
    createCaller('alice', { configDir: tmpDir });
    createCaller('bob', { configDir: tmpDir });
    const callers = listCallers({ configDir: tmpDir }).sort();
    expect(callers).toEqual(['alice', 'bob']);
  });

  it('lists imported caller public keys', () => {
    expect(listCallers({ configDir: tmpDir })).toEqual([]);
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));
    importCallerPublicKeys('peer-a', pub, { configDir: tmpDir });
    expect(listCallers({ configDir: tmpDir })).toEqual(['peer-a']);
  });
});

describe('callerExists / serverExists', () => {
  it('returns false for nonexistent', () => {
    expect(callerExists('nope', { configDir: tmpDir })).toBe(false);
    expect(serverExists({ configDir: tmpDir })).toBe(false);
  });

  it('returns true after creation', () => {
    createCaller('exists', { configDir: tmpDir });
    expect(callerExists('exists', { configDir: tmpDir })).toBe(true);
  });

  it('returns true for server after save', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));
    saveServerPublicKeys(pub, { configDir: tmpDir });
    expect(serverExists({ configDir: tmpDir })).toBe(true);
  });
});

describe('fingerprints', () => {
  it('computes caller fingerprint', () => {
    const result = createCaller('fp-test', { configDir: tmpDir });
    const fp = callerFingerprint('fp-test', { configDir: tmpDir });
    expect(fp).toBe(result.fingerprint);
  });

  it('computes caller fingerprint from public keys only', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));
    importCallerPublicKeys('fp-caller', pub, { configDir: tmpDir });
    const fp = callerFingerprint('fp-caller', { configDir: tmpDir });
    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  it('computes server fingerprint', () => {
    const serverDir = path.join(tmpDir, 'keys', 'server');
    const bundle = generateKeyBundle();
    saveKeyBundle(bundle, serverDir);
    const fp = serverFingerprint({ configDir: tmpDir });
    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });
});
