/**
 * End-to-end tests for the remote server.
 *
 * Boots a real Express app with in-memory keys, performs handshakes
 * over HTTP, sends encrypted requests, and validates the full flow.
 * Replaces the old test-integration.ts custom harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from './server.js';
import type { Config } from '../shared/config.js';
import {
  generateKeyBundle,
  extractPublicKeys,
  saveKeyBundle,
  serializeKeyBundle,
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

// ── Test fixtures ─────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

let clientKeys: KeyBundle;
let serverKeys: KeyBundle;
let clientPub: PublicKeyBundle;
let serverPub: PublicKeyBundle;

const testSecrets: Record<string, string> = {
  TEST_SECRET: 'hello-from-the-vault',
  API_KEY: 'sk-test-1234567890',
};

beforeAll(async () => {
  // Generate fresh key pairs for client and server
  clientKeys = generateKeyBundle();
  serverKeys = generateKeyBundle();
  clientPub = extractPublicKeys(clientKeys);
  serverPub = extractPublicKeys(serverKeys);

  // Build a config that uses our in-memory keys directly
  const config: Config = {
    proxy: {
      remoteUrl: '', // not used server-side
      localKeysDir: '',
      remotePublicKeysDir: '',
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    },
    remote: {
      host: '127.0.0.1',
      port: 0, // not used — we listen on a random port
      localKeysDir: '',
      authorizedPeersDir: '',
      secrets: testSecrets, // literal values, no env var resolution needed
      allowedEndpoints: [], // empty = allow all
      rateLimitPerMinute: 60,
    },
  };

  const app = createApp({
    config,
    ownKeys: serverKeys,
    authorizedPeers: [clientPub],
  });

  // Start on a random available port
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Perform a full handshake and return the encrypted channel + session ID */
async function performHttpHandshake(): Promise<{
  channel: EncryptedChannel;
  sessionId: string;
}> {
  const initiator = new HandshakeInitiator(clientKeys, serverPub);

  // Step 1: Send init
  const initMsg = initiator.createInit();
  const initResp = await fetch(`${baseUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initMsg),
  });
  expect(initResp.ok).toBe(true);

  const reply = (await initResp.json()) as HandshakeReply;

  // Step 2: Process reply and derive keys
  const sessionKeys = initiator.processReply(reply);
  const channel = new EncryptedChannel(sessionKeys);

  // Step 3: Send finish
  const finishMsg = initiator.createFinish(sessionKeys);
  const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionKeys.sessionId,
    },
    body: JSON.stringify(finishMsg),
  });
  expect(finishResp.ok).toBe(true);

  const finishResult = (await finishResp.json()) as { status: string; sessionId: string };
  expect(finishResult.status).toBe('established');

  return { channel, sessionId: sessionKeys.sessionId };
}

/** Send an encrypted tool request and return the decrypted response */
async function sendToolRequest(
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

  const encrypted = channel.encryptJSON(request);
  const resp = await fetch(`${baseUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': channel.sessionId,
    },
    body: new Uint8Array(encrypted),
  });

  expect(resp.ok).toBe(true);
  return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Health check', () => {
  it('should return ok status', async () => {
    const resp = await fetch(`${baseUrl}/health`);
    expect(resp.ok).toBe(true);

    const body = (await resp.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('Handshake', () => {
  it('should complete a full handshake successfully', async () => {
    const { channel, sessionId } = await performHttpHandshake();
    expect(sessionId).toBeDefined();
    expect(channel.sessionId).toBe(sessionId);
  });

  it('should reject unauthorized clients', async () => {
    const rogueKeys = generateKeyBundle();

    const initiator = new HandshakeInitiator(rogueKeys, serverPub);
    const initMsg = initiator.createInit();

    const resp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });

    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain('not authorized');
  });

  it('should reject finish without session ID header', async () => {
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'handshake_finish', payload: 'deadbeef' }),
    });

    expect(resp.status).toBe(400);
  });

  it('should reject finish with unknown session ID', async () => {
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': 'nonexistent-session',
      },
      body: JSON.stringify({ type: 'handshake_finish', payload: 'deadbeef' }),
    });

    expect(resp.status).toBe(404);
  });
});

describe('Encrypted requests', () => {
  let channel: EncryptedChannel;

  beforeAll(async () => {
    const result = await performHttpHandshake();
    channel = result.channel;
  });

  it('should list secrets', async () => {
    const response = await sendToolRequest(channel, 'list_secrets', {});
    expect(response.success).toBe(true);

    const names = response.result as string[];
    expect(names).toContain('TEST_SECRET');
    expect(names).toContain('API_KEY');
  });

  it('should return an error for unknown tools', async () => {
    const response = await sendToolRequest(channel, 'nonexistent_tool', {});
    expect(response.success).toBe(false);
    expect(response.error).toContain('Unknown tool');
  });
});

describe('Security', () => {
  it('should reject replayed encrypted payloads', async () => {
    const { channel } = await performHttpHandshake();

    // Send a valid request first
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_secrets',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const body = new Uint8Array(encrypted);

    // First request succeeds — consume the response to advance the recv counter
    const resp1 = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body,
    });
    expect(resp1.ok).toBe(true);
    const firstResponse = channel.decryptJSON<ProxyResponse>(
      Buffer.from(await resp1.arrayBuffer()),
    );
    expect(firstResponse.success).toBe(true);

    // Replay the exact same encrypted payload — server rejects (counter mismatch)
    const resp2 = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body,
    });
    // Server detects replay: either sends encrypted error (200) or session breaks (500)
    if (resp2.ok) {
      const errorResponse = channel.decryptJSON<ProxyResponse>(
        Buffer.from(await resp2.arrayBuffer()),
      );
      expect(errorResponse.success).toBe(false);
      expect(errorResponse.error).toContain('Counter mismatch');
    } else {
      expect(resp2.status).toBe(500);
    }
  });

  it('should reject requests with unknown session IDs', async () => {
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': 'totally-fake-session-id',
      },
      body: new Uint8Array(Buffer.from('garbage')),
    });

    expect(resp.status).toBe(401);
  });

  it('should reject requests without session ID header', async () => {
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.from('garbage')),
    });

    expect(resp.status).toBe(400);
  });

  it('should support multiple concurrent sessions', async () => {
    const session1 = await performHttpHandshake();
    const session2 = await performHttpHandshake();

    expect(session1.sessionId).not.toBe(session2.sessionId);

    // Both sessions should work independently
    const resp1 = await sendToolRequest(session1.channel, 'list_secrets', {});
    const resp2 = await sendToolRequest(session2.channel, 'list_secrets', {});

    expect(resp1.success).toBe(true);
    expect(resp2.success).toBe(true);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  let rateLimitedServer: Server;
  let rateLimitedUrl: string;

  beforeAll(async () => {
    const config: Config = {
      proxy: {
        remoteUrl: '',
        localKeysDir: '',
        remotePublicKeysDir: '',
        connectTimeout: 10_000,
        requestTimeout: 30_000,
      },
      remote: {
        host: '127.0.0.1',
        port: 0,
        localKeysDir: '',
        authorizedPeersDir: '',
        secrets: { SECRET: 'value' },
        allowedEndpoints: [],
        rateLimitPerMinute: 3, // Very low limit for testing
      },
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [clientPub],
    });

    await new Promise<void>((resolve) => {
      rateLimitedServer = app.listen(0, '127.0.0.1', () => {
        const addr = rateLimitedServer.address() as AddressInfo;
        rateLimitedUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      rateLimitedServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should reject requests that exceed the rate limit', async () => {
    // Perform handshake on the rate-limited server
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${rateLimitedUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${rateLimitedUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);

    // Send 3 requests (within limit)
    for (let i = 0; i < 3; i++) {
      const request: ProxyRequest = {
        type: 'proxy_request',
        id: crypto.randomUUID(),
        toolName: 'list_secrets',
        toolInput: {},
        timestamp: Date.now(),
      };
      const encrypted = channel.encryptJSON(request);
      const resp = await fetch(`${rateLimitedUrl}/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Session-Id': channel.sessionId,
        },
        body: new Uint8Array(encrypted),
      });
      expect(resp.ok).toBe(true);
      // Must consume response to advance recv counter
      channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
    }

    // 4th request should be rate-limited
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_secrets',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${rateLimitedUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.status).toBe(429);
    const body = await resp.text();
    expect(body).toContain('Rate limit exceeded');
  });
});

// ── http_request tool handler ──────────────────────────────────────────────

describe('http_request tool', () => {
  let targetServer: Server;
  let targetUrl: string;
  let httpTestServer: Server;
  let httpTestUrl: string;

  beforeAll(async () => {
    // Create a target HTTP server that the proxy will call
    targetServer = http.createServer((req, res) => {
      if (req.url === '/json-endpoint') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello', auth: req.headers.authorization ?? null }));
      } else if (req.url === '/text-endpoint') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text response');
      } else if (req.url === '/echo-body') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(0, '127.0.0.1', () => {
        const addr = targetServer.address() as AddressInfo;
        targetUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // Create the MCP server with allowedEndpoints set to our target server
    const config: Config = {
      proxy: {
        remoteUrl: '',
        localKeysDir: '',
        remotePublicKeysDir: '',
        connectTimeout: 10_000,
        requestTimeout: 30_000,
      },
      remote: {
        host: '127.0.0.1',
        port: 0,
        localKeysDir: '',
        authorizedPeersDir: '',
        secrets: { MY_TOKEN: 'Bearer secret-jwt-token', BODY_SECRET: 'super-secret-body' },
        allowedEndpoints: [`${targetUrl}/**`],
        rateLimitPerMinute: 60,
      },
    };

    const app = createApp({
      config,
      ownKeys: serverKeys,
      authorizedPeers: [clientPub],
    });

    await new Promise<void>((resolve) => {
      httpTestServer = app.listen(0, '127.0.0.1', () => {
        const addr = httpTestServer.address() as AddressInfo;
        httpTestUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        targetServer.close((err) => (err ? reject(err) : resolve()));
      }),
      new Promise<void>((resolve, reject) => {
        httpTestServer.close((err) => (err ? reject(err) : resolve()));
      }),
    ]);
  });

  /** Perform handshake against the http_request test server */
  async function httpHandshake(): Promise<EncryptedChannel> {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${httpTestUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);
    const channel = new EncryptedChannel(sessionKeys);

    const finishMsg = initiator.createFinish(sessionKeys);
    await fetch(`${httpTestUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });

    return channel;
  }

  /** Send encrypted tool request to the http_request test server */
  async function sendHttpToolRequest(
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
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${httpTestUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
    return channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
  }

  it('should proxy a GET request and return JSON response', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { status: number; body: { message: string } };
    expect(result.status).toBe(200);
    expect(result.body.message).toBe('hello');
  });

  it('should proxy a GET request and return text response', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/text-endpoint`,
      headers: {},
    });

    expect(response.success).toBe(true);
    const result = response.result as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(result.body).toBe('plain text response');
  });

  it('should resolve secret placeholders in headers', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: { Authorization: '${MY_TOKEN}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    expect(result.body.auth).toBe('Bearer secret-jwt-token');
  });

  it('should resolve placeholders in string body', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${targetUrl}/echo-body`,
      headers: { 'Content-Type': 'text/plain' },
      body: 'my secret is ${BODY_SECRET}',
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string } };
    expect(result.body.received).toBe('my secret is super-secret-body');
  });

  it('should resolve placeholders in object body and set Content-Type', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'POST',
      url: `${targetUrl}/echo-body`,
      headers: {},
      body: { key: '${BODY_SECRET}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { received: string; contentType: string } };
    const parsed = JSON.parse(result.body.received) as { key: string };
    expect(parsed.key).toBe('super-secret-body');
    // Should auto-set Content-Type when body is an object and no Content-Type header exists
    expect(result.body.contentType).toContain('application/json');
  });

  it('should reject requests to endpoints not on the allowlist', async () => {
    const channel = await httpHandshake();
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: 'https://evil.example.com/steal-secrets',
      headers: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Endpoint not allowed');
  });

  it('should leave unknown placeholders unchanged with a warning', async () => {
    const channel = await httpHandshake();
    // Send a request where the Authorization header has an unknown placeholder
    const response = await sendHttpToolRequest(channel, 'http_request', {
      method: 'GET',
      url: `${targetUrl}/json-endpoint`,
      headers: { Authorization: '${UNKNOWN_SECRET}' },
    });

    expect(response.success).toBe(true);
    const result = response.result as { body: { auth: string } };
    // The unknown placeholder should be left as-is
    expect(result.body.auth).toBe('${UNKNOWN_SECRET}');
  });
});

// ── Handshake finish edge cases ────────────────────────────────────────────

describe('Handshake finish edge cases', () => {
  it('should reject a finish with an invalid payload (bad verification)', async () => {
    // Perform a normal handshake init to get a valid session
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);

    // Send a finish with garbage payload instead of the real encrypted finish
    const resp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify({
        type: 'handshake_finish',
        payload: crypto.randomBytes(64).toString('hex'),
      }),
    });

    // Should fail — either 403 (finish verification failed) or the verify threw
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBeDefined();
  });
});

// ── loadAuthorizedPeers (disk-based) ───────────────────────────────────────

describe('loadAuthorizedPeers via createApp', () => {
  let peersDir: string;
  let tmpKeysDir: string;

  beforeAll(() => {
    // Create temp directories for peer public keys
    peersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-peers-'));
    tmpKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-keys-'));

    // Save server keys to disk so createApp can load them
    saveKeyBundle(serverKeys, tmpKeysDir);

    // Save one valid peer's public keys
    const peerDir = path.join(peersDir, 'client1');
    fs.mkdirSync(peerDir, { recursive: true });
    const serialized = serializeKeyBundle(clientKeys);
    fs.writeFileSync(path.join(peerDir, 'signing.pub.pem'), serialized.signing.publicKey);
    fs.writeFileSync(path.join(peerDir, 'exchange.pub.pem'), serialized.exchange.publicKey);

    // Also create an invalid peer dir (missing files) to test error handling
    const badPeerDir = path.join(peersDir, 'broken-peer');
    fs.mkdirSync(badPeerDir, { recursive: true });
    fs.writeFileSync(path.join(badPeerDir, 'signing.pub.pem'), 'not-a-valid-key');

    // Create a non-directory entry to test the isDirectory() check
    fs.writeFileSync(path.join(peersDir, 'stray-file.txt'), 'ignore me');
  });

  afterAll(() => {
    fs.rmSync(peersDir, { recursive: true, force: true });
    fs.rmSync(tmpKeysDir, { recursive: true, force: true });
  });

  it('should load peers from disk and allow authorized handshakes', async () => {
    const config: Config = {
      proxy: {
        remoteUrl: '',
        localKeysDir: '',
        remotePublicKeysDir: '',
        connectTimeout: 10_000,
        requestTimeout: 30_000,
      },
      remote: {
        host: '127.0.0.1',
        port: 0,
        localKeysDir: tmpKeysDir,
        authorizedPeersDir: peersDir,
        secrets: { TEST: 'loaded-from-disk' },
        allowedEndpoints: [],
        rateLimitPerMinute: 60,
      },
    };

    // Only pass config — let createApp load keys and peers from disk
    const app = createApp({ config });
    const diskServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = diskServer.address() as AddressInfo;
      const diskUrl = `http://127.0.0.1:${addr.port}`;

      // Handshake from the authorized client should succeed
      const initiator = new HandshakeInitiator(clientKeys, serverPub);
      const initMsg = initiator.createInit();
      const initResp = await fetch(`${diskUrl}/handshake/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initMsg),
      });
      expect(initResp.ok).toBe(true);

      const reply = (await initResp.json()) as HandshakeReply;
      const sessionKeys = initiator.processReply(reply);
      const channel = new EncryptedChannel(sessionKeys);

      const finishMsg = initiator.createFinish(sessionKeys);
      const finishResp = await fetch(`${diskUrl}/handshake/finish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionKeys.sessionId,
        },
        body: JSON.stringify(finishMsg),
      });
      expect(finishResp.ok).toBe(true);

      // Verify we can list secrets (confirms the session is usable)
      const request: ProxyRequest = {
        type: 'proxy_request',
        id: crypto.randomUUID(),
        toolName: 'list_secrets',
        toolInput: {},
        timestamp: Date.now(),
      };
      const encrypted = channel.encryptJSON(request);
      const resp = await fetch(`${diskUrl}/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Session-Id': channel.sessionId,
        },
        body: new Uint8Array(encrypted),
      });
      expect(resp.ok).toBe(true);
      const decrypted = channel.decryptJSON<ProxyResponse>(Buffer.from(await resp.arrayBuffer()));
      expect(decrypted.success).toBe(true);
      expect(decrypted.result).toContain('TEST');
    } finally {
      await new Promise<void>((resolve) => {
        diskServer.close(() => resolve());
      });
    }
  });

  it('should handle non-existent peers directory gracefully', () => {
    const config: Config = {
      proxy: {
        remoteUrl: '',
        localKeysDir: '',
        remotePublicKeysDir: '',
        connectTimeout: 10_000,
        requestTimeout: 30_000,
      },
      remote: {
        host: '127.0.0.1',
        port: 0,
        localKeysDir: '',
        authorizedPeersDir: '/tmp/nonexistent-peers-dir-xyz-' + crypto.randomUUID(),
        secrets: {},
        allowedEndpoints: [],
        rateLimitPerMinute: 60,
      },
    };

    // Should not throw — loadAuthorizedPeers returns empty array if dir doesn't exist
    expect(() =>
      createApp({
        config,
        ownKeys: serverKeys,
        // authorizedPeers not passed, so it'll call loadAuthorizedPeers
      }),
    ).not.toThrow();
  });
});

// ── Handshake without finish (pending handshake coverage) ──────────────────

describe('Pending handshake state', () => {
  it('should create a pending handshake on init that can be completed later', async () => {
    // Start a handshake but don't finish — verifies the pending state is created
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);

    const reply = (await initResp.json()) as HandshakeReply;
    const sessionKeys = initiator.processReply(reply);

    // Completing it later should still work (pending handshake is stored)
    const channel = new EncryptedChannel(sessionKeys);
    const finishMsg = initiator.createFinish(sessionKeys);
    const finishResp = await fetch(`${baseUrl}/handshake/finish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sessionKeys.sessionId,
      },
      body: JSON.stringify(finishMsg),
    });
    expect(finishResp.ok).toBe(true);

    // And the session should be usable
    const request: ProxyRequest = {
      type: 'proxy_request',
      id: crypto.randomUUID(),
      toolName: 'list_secrets',
      toolInput: {},
      timestamp: Date.now(),
    };
    const encrypted = channel.encryptJSON(request);
    const resp = await fetch(`${baseUrl}/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': channel.sessionId,
      },
      body: new Uint8Array(encrypted),
    });
    expect(resp.ok).toBe(true);
  });
});
