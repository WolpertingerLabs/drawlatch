/**
 * HTTP-level tests for `ingest_logs`.
 *
 * Boots the real Express app, performs real handshakes as two different
 * callers, and drives the encrypted `/request` endpoint, so the caller stamp
 * is proven to come from the authenticated session and not the payload.
 * Also pins the write-only property: nothing reachable over the protocol
 * reads, lists, or changes the audit files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createApp, getSessionsSnapshot } from './server.js';
import type { RemoteServerConfig } from '../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  EncryptedChannel,
  type KeyBundle,
  type PublicKeyBundle,
} from '../shared/crypto/index.js';
import {
  HandshakeInitiator,
  type HandshakeReply,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';
import { IngestorManager } from './ingestors/manager.js';
import { toolHandlers } from './tool-dispatch.js';
import { resetAuditLogState, type AuditLine } from './audit-log.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let server: Server;
let baseUrl: string;
let serverPub: PublicKeyBundle;
let aliceKeys: KeyBundle;
let bobKeys: KeyBundle;
let mgr: IngestorManager;
let configDir: string;
let prevConfigDir: string | undefined;

beforeAll(async () => {
  prevConfigDir = process.env.MCP_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-audit-http-'));
  process.env.MCP_CONFIG_DIR = configDir;
  resetAuditLogState();

  aliceKeys = generateKeyBundle();
  bobKeys = generateKeyBundle();
  const serverKeys = generateKeyBundle();
  serverPub = extractPublicKeys(serverKeys);

  const config: RemoteServerConfig = {
    host: '127.0.0.1',
    port: 0,
    connectors: [],
    callers: { alice: { connections: [] }, bob: { connections: [] } },
    rateLimitPerMinute: 100,
  };
  mgr = new IngestorManager(config);

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [
      { alias: 'alice', keys: extractPublicKeys(aliceKeys) },
      { alias: 'bob', keys: extractPublicKeys(bobKeys) },
    ],
    ingestorManager: mgr,
    disableRateLimiting: true,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await mgr.stopAll();
  if (prevConfigDir === undefined) delete process.env.MCP_CONFIG_DIR;
  else process.env.MCP_CONFIG_DIR = prevConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

async function handshake(keys: KeyBundle): Promise<EncryptedChannel> {
  const initiator = new HandshakeInitiator(keys, serverPub);
  const initResp = await fetch(`${baseUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initiator.createInit()),
  });
  const sessionKeys = initiator.processReply((await initResp.json()) as HandshakeReply);
  const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionKeys.sessionId },
    body: JSON.stringify(initiator.createFinish(sessionKeys)),
  });
  expect(finishResp.ok).toBe(true);
  return new EncryptedChannel(sessionKeys);
}

async function call(
  channel: EncryptedChannel,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ProxyResponse> {
  const request: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName,
    toolInput,
    timestamp: Date.now(),
  };
  const resp = await fetch(`${baseUrl}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': channel.sessionId },
    body: new Uint8Array(channel.encryptJSON(request)),
  });
  expect(resp.ok).toBe(true);
  return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
}

function batch(eventName: string, attributes: unknown[] = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'callboard' } }] },
        scopeLogs: [
          {
            scope: { name: 'callboard.permission-review', version: '1' },
            logRecords: [
              {
                timeUnixNano: '1760184000000000000',
                eventName,
                body: { stringValue: 'secret-ish payload' },
                attributes,
                traceId: '0123456789abcdef0123456789abcdef',
                spanId: '0123456789abcdef',
              },
            ],
          },
        ],
      },
    ],
  };
}

function auditFiles(caller: string): string[] {
  const dir = path.join(configDir, 'audit', caller);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [];
}

function readAll(caller: string): AuditLine[] {
  return auditFiles(caller).flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AuditLine),
  );
}

describe('ingest_logs over /request', () => {
  it('stores records under the authenticated caller and returns nothing stored', async () => {
    const channel = await handshake(aliceKeys);
    const response = await call(channel, 'ingest_logs', batch('permission.review.requested'));

    expect(response.success).toBe(true);
    // The reply is the bare ExportLogsServiceResponse: no stored content.
    expect(response.result).toEqual({});

    const [line] = readAll('alice');
    expect(line['drawlatch.caller']).toBe('alice');
    expect(line.event_name).toBe('permission.review.requested');
    expect(fs.statSync(auditFiles('alice')[0]).mode & 0o777).toBe(0o600);

    // One call is one rate-limited request.
    const snap = getSessionsSnapshot().find((s) => channel.sessionId.startsWith(s.sessionIdShort));
    expect(snap?.windowRequests).toBe(1);
  });

  it('ignores a caller identity claimed in the payload', async () => {
    const channel = await handshake(bobKeys);
    const response = await call(
      channel,
      'ingest_logs',
      batch('spoof', [{ key: 'drawlatch.caller', value: { stringValue: 'alice' } }]),
    );
    expect(response.success).toBe(true);

    const bobLines = readAll('bob');
    expect(bobLines).toHaveLength(1);
    expect(bobLines[0]['drawlatch.caller']).toBe('bob');
    // Nothing landed in alice's log.
    expect(readAll('alice').map((l) => l.event_name)).not.toContain('spoof');
  });

  it('reports rejected and kept-with-warnings records in partialSuccess', async () => {
    const channel = await handshake(aliceKeys);
    const input = batch('ok');
    input.resourceLogs[0].scopeLogs[0].logRecords.push('not-a-record' as never);
    input.resourceLogs[0].scopeLogs[0].logRecords.push({ traceId: 'nope' } as never);
    const response = await call(channel, 'ingest_logs', input);
    expect(response.success).toBe(true);
    // The bad traceId is kept under `invalid`; only the non-object is rejected.
    expect(response.result).toMatchObject({ partialSuccess: { rejectedLogRecords: 1 } });
  });

  it('refuses requests without an authenticated session', async () => {
    const before = readAll('alice').length;
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Session-Id': 'not-a-session' },
      body: new Uint8Array(Buffer.from(JSON.stringify(batch('anon')))),
    });
    expect(resp.status).toBe(401);
    expect(readAll('alice')).toHaveLength(before);
  });
});

describe('ingest_logs is write-only over the protocol', () => {
  /**
   * Ingest a unique canary, then call every registered tool, as the owner and
   * as another caller, with empty input and with inputs pointing straight at
   * the audit file. No response may contain the canary. This catches a read
   * path whatever it is named or wherever it lives.
   */
  it('no registered tool returns stored audit content', async () => {
    const canary = `canary-${crypto.randomUUID()}`;
    const owner = await handshake(aliceKeys);
    const stored = await call(
      owner,
      'ingest_logs',
      batch(canary, [{ key: 'note', value: { stringValue: canary } }]),
    );
    expect(stored.success).toBe(true);
    const [auditFile] = auditFiles('alice');
    expect(fs.readFileSync(auditFile, 'utf8')).toContain(canary);

    const auditDir = path.dirname(auditFile);
    const inputs: Record<string, unknown>[] = [
      { timeout_ms: 0 },
      {
        timeout_ms: 0,
        caller: 'alice',
        alias: 'alice',
        connection: 'audit',
        path: auditFile,
        file: auditFile,
        dir: auditDir,
        url: `file://${auditFile}`,
        method: 'GET',
        after_id: -1,
        afterId: -1,
        cursors: {},
        instance_id: '_default',
      },
      {
        timeout_ms: 0,
        path: auditDir,
        url: `${baseUrl}/health`,
        date: path.basename(auditFile, '.jsonl'),
      },
    ];

    const leaks: string[] = [];
    for (const keys of [aliceKeys, bobKeys]) {
      for (const toolName of Object.keys(toolHandlers)) {
        // A fresh session per tool keeps the sweep under the per-session rate limit.
        const channel = await handshake(keys);
        for (const input of inputs) {
          const response = await call(channel, toolName, input);
          if (JSON.stringify(response).includes(canary)) {
            leaks.push(
              `${keys === aliceKeys ? 'alice' : 'bob'}:${toolName}:${JSON.stringify(input)}`,
            );
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('no source outside audit-log.ts builds a path to the audit directory', () => {
    const srcRoot = path.resolve(here, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'audit-log.ts' &&
          /['"`]audit['"`/]/.test(fs.readFileSync(full, 'utf8'))
        ) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('is not exposed by the local MCP server', () => {
    expect(fs.readFileSync(path.join(here, '..', 'mcp', 'server.ts'), 'utf8')).not.toContain(
      'ingest_logs',
    );
  });
});
