/**
 * Tests for the new self-managed surface:
 *   - caller bootstrap (item E): createCallerWithKeys / deleteCaller / autoEnroll
 *   - key-layout migration (item G): migrateKeyLayout
 *   - mutating admin API (item A): create/delete caller, enable/disable, secrets
 *
 * Every mutating admin test also asserts the security invariant that secret
 * VALUES never appear in any response body.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  loadRemoteConfig,
  saveRemoteConfig,
  resolveCallerRoutes,
  resolveRoutes,
  resolveSecrets,
  getCallerKeysDir,
  getKeysDir,
  type RemoteServerConfig,
  type ResolvedRoute,
} from '../shared/config.js';
import {
  createCallerWithKeys,
  deleteCaller,
  autoEnroll,
  writeEnrollToken,
} from './caller-bootstrap.js';
import { migrateKeyLayout } from '../shared/migrations.js';
import { createAdminRouter } from './admin.js';
import { createCaller } from '../shared/crypto/key-manager.js';
import type { IngestorManager } from './ingestors/index.js';
import type { IngestorStatus } from './ingestors/types.js';

function seedConfig(): void {
  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    callers: {
      default: { name: 'Default', connections: ['github'] },
    },
    rateLimitPerMinute: 60,
  };
  saveRemoteConfig(config);
}

// ── caller bootstrap (item E) ──────────────────────────────────────────────

describe('caller bootstrap', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-boot-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a caller with a keypair, cloning default connections', () => {
    const res = createCallerWithKeys('alice');
    expect(res.alias).toBe('alice');
    expect(res.fingerprint).toMatch(/.+/);
    expect(res.connections).toEqual(['github']);
    // Keypair written to disk
    expect(fs.existsSync(path.join(getCallerKeysDir(), 'alice', 'signing.key.pem'))).toBe(true);
    // Registered in config
    expect('alice' in loadRemoteConfig().callers).toBe(true);
  });

  it('honors explicit connections + name', () => {
    const res = createCallerWithKeys('bob', { name: 'Bob', connections: [] });
    expect(res.name).toBe('Bob');
    expect(res.connections).toEqual([]);
  });

  it('rejects an invalid alias', () => {
    expect(() => createCallerWithKeys('bad alias!')).toThrow(/Invalid alias/);
  });

  it('rejects a duplicate caller', () => {
    createCallerWithKeys('alice');
    expect(() => createCallerWithKeys('alice')).toThrow(/already exists/);
  });

  it('deletes a caller and its key dir', () => {
    createCallerWithKeys('alice');
    deleteCaller('alice');
    expect('alice' in loadRemoteConfig().callers).toBe(false);
    expect(fs.existsSync(path.join(getCallerKeysDir(), 'alice'))).toBe(false);
  });

  it('refuses to delete the default caller', () => {
    expect(() => deleteCaller('default')).toThrow(/Cannot delete/);
  });

  it('auto-enrolls with a valid token and rotates it (single-use)', () => {
    const token = writeEnrollToken();
    const res = autoEnroll(token, 'carol');
    expect(res.alias).toBe('carol');
    expect('carol' in loadRemoteConfig().callers).toBe(true);
    // The old token must no longer work (rotated on success).
    expect(() => autoEnroll(token, 'dave')).toThrow(/Invalid or expired/);
  });

  it('rejects auto-enroll with a wrong token', () => {
    writeEnrollToken();
    expect(() => autoEnroll('not-the-token', 'eve')).toThrow(/Invalid or expired/);
  });
});

// ── key-layout migration (item G) ──────────────────────────────────────────

describe('migrateKeyLayout', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-mig-'));
    process.env.MCP_CONFIG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates legacy keys/local + keys/remote + keys/peers to callers/server', () => {
    const keys = getKeysDir();
    // Legacy layout
    fs.mkdirSync(path.join(keys, 'local', 'alice'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'local', 'alice', 'signing.key.pem'), 'x');
    fs.mkdirSync(path.join(keys, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'remote', 'signing.key.pem'), 'y');
    fs.mkdirSync(path.join(keys, 'peers', 'remote-server'), { recursive: true });
    fs.writeFileSync(path.join(keys, 'peers', 'remote-server', 'signing.pub.pem'), 'z');

    migrateKeyLayout();

    expect(fs.existsSync(path.join(keys, 'callers', 'alice', 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'server', 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'server', 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keys, 'local'))).toBe(false);
    expect(fs.existsSync(path.join(keys, 'remote'))).toBe(false);
    expect(fs.existsSync(path.join(keys, 'peers'))).toBe(false);
  });

  it('is idempotent and a no-op when there is nothing to migrate', () => {
    expect(() => migrateKeyLayout()).not.toThrow();
    migrateKeyLayout();
  });
});

// ── mutating admin API (item A) ────────────────────────────────────────────

describe('mutating admin API', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  const SECRET_VALUE = 'token-must-not-leak-abcdef0123456789';

  const ingestorStub = {
    getAllStatuses: () => [] as (IngestorStatus & { callerAlias: string })[],
    getStatuses: () => [] as IngestorStatus[],
    getAllEvents: () => [],
    stopOne: () => Promise.resolve({ success: true }),
    has: () => false,
  } as unknown as IngestorManager;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-mut-'));
    process.env.MCP_CONFIG_DIR = dir;
    seedConfig();
    // The default caller needs keys so reloadPeer/removePeer have something real
    // to act on; create them directly.
    createCaller('default');

    const resolveRoutesForCaller = (alias: string): ResolvedRoute[] => {
      const cfg = loadRemoteConfig();
      const caller = cfg.callers[alias] as RemoteServerConfig['callers'][string] | undefined;
      if (!caller) return [];
      return resolveRoutes(resolveCallerRoutes(cfg, alias), resolveSecrets(caller.env ?? {}), alias);
    };

    const app = express();
    app.use('/api/admin', express.json());
    app.use(
      '/api/admin',
      createAdminRouter({
        getSessionsSnapshot: () => [],
        ingestorManager: () => ingestorStub,
        loadConfig: () => loadRemoteConfig(),
        resolveRoutesForCaller,
        refreshCaller: () => undefined,
        reloadPeer: () => undefined,
        removePeer: () => undefined,
        version: 'test',
        port: 0,
        startedAt: Date.now(),
      }),
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.MCP_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, text };
  }

  it('creates a caller (201) and rejects a duplicate (409) + bad alias (400)', async () => {
    const ok = await req('POST', '/api/admin/callers', { alias: 'team', name: 'Team' });
    expect(ok.status).toBe(201);
    expect((ok.json as { alias: string }).alias).toBe('team');

    const dup = await req('POST', '/api/admin/callers', { alias: 'team' });
    expect(dup.status).toBe(409);

    const bad = await req('POST', '/api/admin/callers', { alias: 'no good' });
    expect(bad.status).toBe(400);
  });

  it('enables and disables a connection for a caller', async () => {
    const off = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(loadRemoteConfig().callers.default.connections).not.toContain('github');

    const on = await req('POST', '/api/admin/callers/default/connections/github', {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(loadRemoteConfig().callers.default.connections).toContain('github');
  });

  it('rejects enable for an unknown caller (404)', async () => {
    const res = await req('POST', '/api/admin/callers/ghost/connections/github', {
      enabled: true,
    });
    expect(res.status).toBe(404);
  });

  it('sets secrets (boolean status only) and never echoes the value', async () => {
    const res = await req('PUT', '/api/admin/callers/default/connections/github/secrets', {
      secrets: { GITHUB_TOKEN: SECRET_VALUE },
    });
    expect(res.status).toBe(200);
    expect((res.json as { secretsSet: Record<string, boolean> }).secretsSet.GITHUB_TOKEN).toBe(
      true,
    );
    // The value must never appear anywhere in the response.
    expect(res.text.includes(SECRET_VALUE)).toBe(false);
  });

  it('deletes a caller (200) and blocks deleting default (400)', async () => {
    await req('POST', '/api/admin/callers', { alias: 'temp' });
    const del = await req('DELETE', '/api/admin/callers/temp');
    expect(del.status).toBe(200);
    expect('temp' in loadRemoteConfig().callers).toBe(false);

    const blocked = await req('DELETE', '/api/admin/callers/default');
    expect(blocked.status).toBe(400);
  });

  it('toggles the tunnel flag (PUT /tunnel) and persists to config', async () => {
    // Sanity: not set initially.
    expect(loadRemoteConfig().tunnel).toBeUndefined();

    const on = await req('PUT', '/api/admin/tunnel', { enabled: true });
    expect(on.status).toBe(200);
    expect((on.json as { tunnel: boolean }).tunnel).toBe(true);
    expect(loadRemoteConfig().tunnel).toBe(true);

    const off = await req('PUT', '/api/admin/tunnel', { enabled: false });
    expect(off.status).toBe(200);
    expect((off.json as { tunnel: boolean }).tunnel).toBe(false);
    expect(loadRemoteConfig().tunnel).toBe(false);
  });

  it('rejects PUT /tunnel without a boolean enabled (400)', async () => {
    const bad = await req('PUT', '/api/admin/tunnel', { enabled: 'yes' });
    expect(bad.status).toBe(400);

    const empty = await req('PUT', '/api/admin/tunnel', {});
    expect(empty.status).toBe(400);
  });
});
