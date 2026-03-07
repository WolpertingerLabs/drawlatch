import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCaller,
  exportPublicKeys,
  importPeerPublicKeys,
  exportPeerPublicKeys,
  saveRemotePublicKeys,
  listCallers,
  listPeers,
  callerExists,
  peerExists,
  callerFingerprint,
  peerFingerprint,
} from './key-manager.js';
import { generateKeyBundle, saveKeyBundle, extractPublicKeys, serializePublicKeys } from './keys.js';

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
    const keyDir = path.join(tmpDir, 'keys', 'local', 'test-caller');
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

describe('exportPublicKeys', () => {
  it('exports local caller public keys', () => {
    const created = createCaller('export-test', { configDir: tmpDir });
    const exported = exportPublicKeys('local', 'export-test', { configDir: tmpDir });
    expect(exported.signing).toBe(created.publicKeys.signing);
    expect(exported.exchange).toBe(created.publicKeys.exchange);
  });

  it('exports remote server public keys', () => {
    // Set up a remote key bundle
    const remoteDir = path.join(tmpDir, 'keys', 'remote');
    const bundle = generateKeyBundle();
    saveKeyBundle(bundle, remoteDir);

    const exported = exportPublicKeys('remote', undefined, { configDir: tmpDir });
    expect(exported.signing).toContain('PUBLIC KEY');
    expect(exported.exchange).toContain('PUBLIC KEY');
  });
});

describe('importPeerPublicKeys / exportPeerPublicKeys', () => {
  it('round-trips peer public keys', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));

    importPeerPublicKeys('my-peer', pub, { configDir: tmpDir });
    const exported = exportPeerPublicKeys('my-peer', { configDir: tmpDir });

    expect(exported.signing).toBe(pub.signing);
    expect(exported.exchange).toBe(pub.exchange);
  });
});

describe('saveRemotePublicKeys', () => {
  it('saves under peers/remote-server/', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));

    saveRemotePublicKeys(pub, { configDir: tmpDir });
    expect(peerExists('remote-server', { configDir: tmpDir })).toBe(true);
  });
});

describe('listCallers / listPeers', () => {
  it('lists created callers', () => {
    expect(listCallers({ configDir: tmpDir })).toEqual([]);
    createCaller('alice', { configDir: tmpDir });
    createCaller('bob', { configDir: tmpDir });
    const callers = listCallers({ configDir: tmpDir }).sort();
    expect(callers).toEqual(['alice', 'bob']);
  });

  it('lists imported peers', () => {
    expect(listPeers({ configDir: tmpDir })).toEqual([]);
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));
    importPeerPublicKeys('peer-a', pub, { configDir: tmpDir });
    expect(listPeers({ configDir: tmpDir })).toEqual(['peer-a']);
  });
});

describe('callerExists / peerExists', () => {
  it('returns false for nonexistent', () => {
    expect(callerExists('nope', { configDir: tmpDir })).toBe(false);
    expect(peerExists('nope', { configDir: tmpDir })).toBe(false);
  });

  it('returns true after creation', () => {
    createCaller('exists', { configDir: tmpDir });
    expect(callerExists('exists', { configDir: tmpDir })).toBe(true);
  });
});

describe('fingerprints', () => {
  it('computes caller fingerprint', () => {
    const result = createCaller('fp-test', { configDir: tmpDir });
    const fp = callerFingerprint('fp-test', { configDir: tmpDir });
    expect(fp).toBe(result.fingerprint);
  });

  it('computes peer fingerprint', () => {
    const bundle = generateKeyBundle();
    const pub = serializePublicKeys(extractPublicKeys(bundle));
    importPeerPublicKeys('fp-peer', pub, { configDir: tmpDir });
    const fp = peerFingerprint('fp-peer', { configDir: tmpDir });
    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });
});
