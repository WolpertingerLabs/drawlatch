/**
 * End-to-end tests for the remote server.
 *
 * Boots a real Express app with in-memory keys, performs handshakes
 * over HTTP, sends encrypted requests, and validates the full flow.
 * Tests route-based secret scoping, header injection, and header conflict rejection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.js';
import { generateKeyBundle, extractPublicKeys, saveKeyBundle, serializeKeyBundle, EncryptedChannel, } from '../shared/crypto/index.js';
import { HandshakeInitiator, } from '../shared/protocol/index.js';
// ── Test fixtures ─────────────────────────────────────────────────────────
let server;
let baseUrl;
let clientKeys;
let serverKeys;
let clientPub;
let serverPub;
const testSecrets = {
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
    const config = {
        host: '127.0.0.1',
        port: 0, // not used — we listen on a random port
        localKeysDir: '',
        connectors: [
            {
                alias: 'test-route',
                secrets: testSecrets, // literal values, no env var resolution needed
                allowedEndpoints: [], // empty = matches nothing (we use a different server for http_request tests)
            },
        ],
        callers: {
            'test-client': { peerKeyDir: '', connections: ['test-route'] },
        },
        rateLimitPerMinute: 60,
    };
    const app = createApp({
        config,
        ownKeys: serverKeys,
        authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
    });
    // Start on a random available port
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            baseUrl = `http://127.0.0.1:${addr.port}`;
            resolve();
        });
    });
});
afterAll(async () => {
    await new Promise((resolve, reject) => {
        server.close((err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
});
// ── Helpers ───────────────────────────────────────────────────────────────
/** Perform a full handshake and return the encrypted channel + session ID */
async function performHttpHandshake() {
    const initiator = new HandshakeInitiator(clientKeys, serverPub);
    // Step 1: Send init
    const initMsg = initiator.createInit();
    const initResp = await fetch(`${baseUrl}/handshake/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initMsg),
    });
    expect(initResp.ok).toBe(true);
    const reply = (await initResp.json());
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
    const finishResult = (await finishResp.json());
    expect(finishResult.status).toBe('established');
    return { channel, sessionId: sessionKeys.sessionId };
}
/** Send an encrypted tool request and return the decrypted response */
async function sendToolRequest(channel, toolName, toolInput) {
    const request = {
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
    return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
}
// ── Tests ─────────────────────────────────────────────────────────────────
describe('Health check', () => {
    it('should return ok status', async () => {
        const resp = await fetch(`${baseUrl}/health`);
        expect(resp.ok).toBe(true);
        const body = (await resp.json());
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
        const body = (await resp.json());
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
    let channel;
    beforeAll(async () => {
        const result = await performHttpHandshake();
        channel = result.channel;
    });
    it('should list routes', async () => {
        const response = await sendToolRequest(channel, 'list_routes', {});
        expect(response.success).toBe(true);
        const routes = response.result;
        expect(routes).toHaveLength(1);
        expect(routes[0].index).toBe(0);
        expect(routes[0].secretNames).toContain('TEST_SECRET');
        expect(routes[0].secretNames).toContain('API_KEY');
        expect(routes[0].allowedEndpoints).toEqual([]);
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
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName: 'list_routes',
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
        const firstResponse = channel.decryptJSON(Buffer.from(await resp1.arrayBuffer()));
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
            const errorResponse = channel.decryptJSON(Buffer.from(await resp2.arrayBuffer()));
            expect(errorResponse.success).toBe(false);
            expect(errorResponse.error).toContain('Counter mismatch');
        }
        else {
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
        const resp1 = await sendToolRequest(session1.channel, 'list_routes', {});
        const resp2 = await sendToolRequest(session2.channel, 'list_routes', {});
        expect(resp1.success).toBe(true);
        expect(resp2.success).toBe(true);
    });
});
// ── Rate limiting ──────────────────────────────────────────────────────────
describe('Rate limiting', () => {
    let rateLimitedServer;
    let rateLimitedUrl;
    beforeAll(async () => {
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'rate-test',
                    secrets: { SECRET: 'value' },
                    allowedEndpoints: [],
                },
            ],
            callers: {
                'test-client': { peerKeyDir: '', connections: ['rate-test'] },
            },
            rateLimitPerMinute: 3, // Very low limit for testing
        };
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
        });
        await new Promise((resolve) => {
            rateLimitedServer = app.listen(0, '127.0.0.1', () => {
                const addr = rateLimitedServer.address();
                rateLimitedUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await new Promise((resolve, reject) => {
            rateLimitedServer.close((err) => {
                if (err)
                    reject(err);
                else
                    resolve();
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
        const reply = (await initResp.json());
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
            const request = {
                type: 'proxy_request',
                id: crypto.randomUUID(),
                toolName: 'list_routes',
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
            channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
        }
        // 4th request should be rate-limited
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName: 'list_routes',
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
    let targetServer;
    let targetUrl;
    let httpTestServer;
    let httpTestUrl;
    beforeAll(async () => {
        // Create a target HTTP server that the proxy will call
        targetServer = http.createServer((req, res) => {
            if (req.url === '/json-endpoint') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'hello', auth: req.headers.authorization ?? null }));
            }
            else if (req.url === '/text-endpoint') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('plain text response');
            }
            else if (req.url === '/echo-body') {
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
                });
            }
            else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
            }
        });
        await new Promise((resolve) => {
            targetServer.listen(0, '127.0.0.1', () => {
                const addr = targetServer.address();
                targetUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
        // Create the MCP server with route-based config
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'http-test',
                    secrets: { MY_TOKEN: 'Bearer secret-jwt-token', BODY_SECRET: 'super-secret-body' },
                    allowedEndpoints: [`${targetUrl}/**`],
                },
            ],
            callers: {
                'test-client': { peerKeyDir: '', connections: ['http-test'] },
            },
            rateLimitPerMinute: 60,
        };
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
        });
        await new Promise((resolve) => {
            httpTestServer = app.listen(0, '127.0.0.1', () => {
                const addr = httpTestServer.address();
                httpTestUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await Promise.all([
            new Promise((resolve, reject) => {
                targetServer.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                httpTestServer.close((err) => (err ? reject(err) : resolve()));
            }),
        ]);
    });
    /** Perform handshake against the http_request test server */
    async function httpHandshake() {
        const initiator = new HandshakeInitiator(clientKeys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${httpTestUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        const reply = (await initResp.json());
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
    async function sendHttpToolRequest(channel, toolName, toolInput) {
        const request = {
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
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should proxy a GET request and return JSON response', async () => {
        const channel = await httpHandshake();
        const response = await sendHttpToolRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrl}/json-endpoint`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
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
        const result = response.result;
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
        const result = response.result;
        expect(result.body.auth).toBe('Bearer secret-jwt-token');
    });
    it('should NOT resolve placeholders in string body by default (resolveSecretsInBody=false)', async () => {
        const channel = await httpHandshake();
        const response = await sendHttpToolRequest(channel, 'http_request', {
            method: 'POST',
            url: `${targetUrl}/echo-body`,
            headers: { 'Content-Type': 'text/plain' },
            body: 'my secret is ${BODY_SECRET}',
        });
        expect(response.success).toBe(true);
        const result = response.result;
        // Placeholder should be left as-is — not resolved
        expect(result.body.received).toBe('my secret is ${BODY_SECRET}');
    });
    it('should NOT resolve placeholders in object body by default (resolveSecretsInBody=false)', async () => {
        const channel = await httpHandshake();
        const response = await sendHttpToolRequest(channel, 'http_request', {
            method: 'POST',
            url: `${targetUrl}/echo-body`,
            headers: {},
            body: { key: '${BODY_SECRET}' },
        });
        expect(response.success).toBe(true);
        const result = response.result;
        const parsed = JSON.parse(result.body.received);
        // Placeholder should be left as-is — not resolved
        expect(parsed.key).toBe('${BODY_SECRET}');
        // Should still auto-set Content-Type when body is an object
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
        const result = response.result;
        // The unknown placeholder should be left as-is
        expect(result.body.auth).toBe('${UNKNOWN_SECRET}');
    });
});
// ── resolveSecretsInBody opt-in ──────────────────────────────────────────────
describe('http_request with resolveSecretsInBody enabled', () => {
    let bodyTargetServer;
    let bodyTargetUrl;
    let bodyTestServer;
    let bodyTestUrl;
    beforeAll(async () => {
        // Target server that echoes the body back
        bodyTargetServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ received: body, contentType: req.headers['content-type'] }));
            });
        });
        await new Promise((resolve) => {
            bodyTargetServer.listen(0, '127.0.0.1', () => {
                const addr = bodyTargetServer.address();
                bodyTargetUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'body-test',
                    secrets: { MY_TOKEN: 'Bearer secret-jwt-token', BODY_SECRET: 'super-secret-body' },
                    allowedEndpoints: [`${bodyTargetUrl}/**`],
                    resolveSecretsInBody: true,
                },
            ],
            callers: {
                'test-client': { peerKeyDir: '', connections: ['body-test'] },
            },
            rateLimitPerMinute: 60,
        };
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
        });
        await new Promise((resolve) => {
            bodyTestServer = app.listen(0, '127.0.0.1', () => {
                const addr = bodyTestServer.address();
                bodyTestUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await Promise.all([
            new Promise((resolve, reject) => {
                bodyTargetServer.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                bodyTestServer.close((err) => (err ? reject(err) : resolve()));
            }),
        ]);
    });
    async function bodyHandshake() {
        const initiator = new HandshakeInitiator(clientKeys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${bodyTestUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        const reply = (await initResp.json());
        const sessionKeys = initiator.processReply(reply);
        const channel = new EncryptedChannel(sessionKeys);
        const finishMsg = initiator.createFinish(sessionKeys);
        await fetch(`${bodyTestUrl}/handshake/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': sessionKeys.sessionId,
            },
            body: JSON.stringify(finishMsg),
        });
        return channel;
    }
    async function sendBodyToolRequest(channel, toolName, toolInput) {
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName,
            toolInput,
            timestamp: Date.now(),
        };
        const encrypted = channel.encryptJSON(request);
        const resp = await fetch(`${bodyTestUrl}/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Session-Id': channel.sessionId,
            },
            body: new Uint8Array(encrypted),
        });
        expect(resp.ok).toBe(true);
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should resolve placeholders in string body when resolveSecretsInBody is true', async () => {
        const channel = await bodyHandshake();
        const response = await sendBodyToolRequest(channel, 'http_request', {
            method: 'POST',
            url: `${bodyTargetUrl}/echo`,
            headers: { 'Content-Type': 'text/plain' },
            body: 'my secret is ${BODY_SECRET}',
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.received).toBe('my secret is super-secret-body');
    });
    it('should resolve placeholders in object body when resolveSecretsInBody is true', async () => {
        const channel = await bodyHandshake();
        const response = await sendBodyToolRequest(channel, 'http_request', {
            method: 'POST',
            url: `${bodyTargetUrl}/echo`,
            headers: {},
            body: { key: '${BODY_SECRET}' },
        });
        expect(response.success).toBe(true);
        const result = response.result;
        const parsed = JSON.parse(result.body.received);
        expect(parsed.key).toBe('super-secret-body');
        expect(result.body.contentType).toContain('application/json');
    });
});
// ── Route isolation ────────────────────────────────────────────────────────
describe('Route isolation', () => {
    let targetServerA;
    let targetUrlA;
    let targetServerB;
    let targetUrlB;
    let isolationServer;
    let isolationUrl;
    beforeAll(async () => {
        // Create two target HTTP servers
        targetServerA = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ server: 'A', auth: req.headers.authorization ?? null }));
        });
        targetServerB = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ server: 'B', auth: req.headers.authorization ?? null }));
        });
        await Promise.all([
            new Promise((resolve) => {
                targetServerA.listen(0, '127.0.0.1', () => {
                    const addr = targetServerA.address();
                    targetUrlA = `http://127.0.0.1:${addr.port}`;
                    resolve();
                });
            }),
            new Promise((resolve) => {
                targetServerB.listen(0, '127.0.0.1', () => {
                    const addr = targetServerB.address();
                    targetUrlB = `http://127.0.0.1:${addr.port}`;
                    resolve();
                });
            }),
        ]);
        // Create a server with two routes pointing to different targets
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'route-a',
                    headers: { Authorization: 'Bearer route-a-token' },
                    secrets: { TOKEN_A: 'secret-a-value' },
                    allowedEndpoints: [`${targetUrlA}/**`],
                },
                {
                    alias: 'route-b',
                    headers: { Authorization: 'Bearer route-b-token' },
                    secrets: { TOKEN_B: 'secret-b-value' },
                    allowedEndpoints: [`${targetUrlB}/**`],
                },
            ],
            callers: {
                'test-client': { peerKeyDir: '', connections: ['route-a', 'route-b'] },
            },
            rateLimitPerMinute: 60,
        };
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
        });
        await new Promise((resolve) => {
            isolationServer = app.listen(0, '127.0.0.1', () => {
                const addr = isolationServer.address();
                isolationUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await Promise.all([
            new Promise((resolve, reject) => {
                targetServerA.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                targetServerB.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                isolationServer.close((err) => (err ? reject(err) : resolve()));
            }),
        ]);
    });
    async function isolationHandshake() {
        const initiator = new HandshakeInitiator(clientKeys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${isolationUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        const reply = (await initResp.json());
        const sessionKeys = initiator.processReply(reply);
        const channel = new EncryptedChannel(sessionKeys);
        const finishMsg = initiator.createFinish(sessionKeys);
        await fetch(`${isolationUrl}/handshake/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': sessionKeys.sessionId,
            },
            body: JSON.stringify(finishMsg),
        });
        return channel;
    }
    async function sendIsolationRequest(channel, toolName, toolInput) {
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName,
            toolInput,
            timestamp: Date.now(),
        };
        const encrypted = channel.encryptJSON(request);
        const resp = await fetch(`${isolationUrl}/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Session-Id': channel.sessionId,
            },
            body: new Uint8Array(encrypted),
        });
        expect(resp.ok).toBe(true);
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should inject route-level headers for route A', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlA}/anything`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.server).toBe('A');
        expect(result.body.auth).toBe('Bearer route-a-token');
    });
    it('should inject route-level headers for route B', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlB}/anything`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.server).toBe('B');
        expect(result.body.auth).toBe('Bearer route-b-token');
    });
    it('should only resolve secrets from the matched route (route A)', async () => {
        const channel = await isolationHandshake();
        // TOKEN_A belongs to route A, TOKEN_B belongs to route B
        // Requesting route A's endpoint should only resolve route A's secrets
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlA}/anything`,
            headers: { 'X-Token-A': '${TOKEN_A}', 'X-Token-B': '${TOKEN_B}' },
        });
        expect(response.success).toBe(true);
        // Route A's Authorization header is injected by the server
        // X-Token-A should resolve, X-Token-B should NOT (left as placeholder)
    });
    it('should reject request when client header conflicts with route header', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlA}/anything`,
            headers: { Authorization: 'Bearer client-override-attempt' },
        });
        expect(response.success).toBe(false);
        expect(response.error).toContain('Header conflict');
        expect(response.error).toContain('Authorization');
    });
    it('should reject request when client header conflicts with route header (case-insensitive)', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlA}/anything`,
            headers: { authorization: 'Bearer client-override-attempt' },
        });
        expect(response.success).toBe(false);
        expect(response.error).toContain('Header conflict');
    });
    it('should reject requests to unmatched endpoints', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'http_request', {
            method: 'GET',
            url: 'https://evil.example.com/steal-secrets',
            headers: {},
        });
        expect(response.success).toBe(false);
        expect(response.error).toContain('Endpoint not allowed');
    });
    it('should list all routes with metadata', async () => {
        const channel = await isolationHandshake();
        const response = await sendIsolationRequest(channel, 'list_routes', {});
        expect(response.success).toBe(true);
        const routes = response.result;
        expect(routes).toHaveLength(2);
        // Route 0 — targets server A
        expect(routes[0].index).toBe(0);
        expect(routes[0].secretNames).toContain('TOKEN_A');
        expect(routes[0].autoHeaders).toContain('Authorization');
        // Route 1 — targets server B
        expect(routes[1].index).toBe(1);
        expect(routes[1].secretNames).toContain('TOKEN_B');
        expect(routes[1].autoHeaders).toContain('Authorization');
    });
});
// ── Route metadata ─────────────────────────────────────────────────────────
describe('Route metadata in list_routes', () => {
    let metadataServer;
    let metadataUrl;
    beforeAll(async () => {
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'github',
                    name: 'GitHub API',
                    description: 'Access to GitHub REST API v3',
                    docsUrl: 'https://docs.github.com/en/rest',
                    openApiUrl: 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
                    secrets: { GH_TOKEN: 'ghp_test123' },
                    headers: { Authorization: 'Bearer ${GH_TOKEN}' },
                    allowedEndpoints: ['https://api.github.com/**'],
                },
                {
                    alias: 'stripe',
                    // Route without metadata — should still work
                    secrets: { STRIPE_KEY: 'sk_test_abc' },
                    allowedEndpoints: ['https://api.stripe.com/**'],
                },
                {
                    alias: 'internal',
                    name: 'Internal API',
                    // description and docsUrl intentionally omitted
                    secrets: {},
                    allowedEndpoints: ['https://internal.example.com/**'],
                },
            ],
            callers: {
                'test-client': { peerKeyDir: '', connections: ['github', 'stripe', 'internal'] },
            },
            rateLimitPerMinute: 60,
        };
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers: [{ alias: 'test-client', keys: clientPub }],
        });
        await new Promise((resolve) => {
            metadataServer = app.listen(0, '127.0.0.1', () => {
                const addr = metadataServer.address();
                metadataUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await new Promise((resolve, reject) => {
            metadataServer.close((err) => (err ? reject(err) : resolve()));
        });
    });
    async function metadataHandshake() {
        const initiator = new HandshakeInitiator(clientKeys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${metadataUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        const reply = (await initResp.json());
        const sessionKeys = initiator.processReply(reply);
        const channel = new EncryptedChannel(sessionKeys);
        const finishMsg = initiator.createFinish(sessionKeys);
        await fetch(`${metadataUrl}/handshake/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': sessionKeys.sessionId,
            },
            body: JSON.stringify(finishMsg),
        });
        return channel;
    }
    async function sendMetadataRequest(channel, toolName, toolInput) {
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName,
            toolInput,
            timestamp: Date.now(),
        };
        const encrypted = channel.encryptJSON(request);
        const resp = await fetch(`${metadataUrl}/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Session-Id': channel.sessionId,
            },
            body: new Uint8Array(encrypted),
        });
        expect(resp.ok).toBe(true);
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should return route metadata fields when present', async () => {
        const channel = await metadataHandshake();
        const response = await sendMetadataRequest(channel, 'list_routes', {});
        expect(response.success).toBe(true);
        const routes = response.result;
        expect(routes).toHaveLength(3);
        // Route 0 — full metadata
        expect(routes[0].name).toBe('GitHub API');
        expect(routes[0].description).toBe('Access to GitHub REST API v3');
        expect(routes[0].docsUrl).toBe('https://docs.github.com/en/rest');
        expect(routes[0].openApiUrl).toBe('https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json');
        expect(routes[0].allowedEndpoints).toEqual(['https://api.github.com/**']);
        expect(routes[0].secretNames).toEqual(['GH_TOKEN']);
        expect(routes[0].autoHeaders).toEqual(['Authorization']);
        // Route 1 — no metadata
        expect(routes[1].name).toBeUndefined();
        expect(routes[1].description).toBeUndefined();
        expect(routes[1].docsUrl).toBeUndefined();
        expect(routes[1].openApiUrl).toBeUndefined();
        expect(routes[1].secretNames).toEqual(['STRIPE_KEY']);
        // Route 2 — partial metadata (name only)
        expect(routes[2].name).toBe('Internal API');
        expect(routes[2].description).toBeUndefined();
        expect(routes[2].docsUrl).toBeUndefined();
        expect(routes[2].openApiUrl).toBeUndefined();
        expect(routes[2].secretNames).toEqual([]);
        expect(routes[2].autoHeaders).toEqual([]);
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
        const reply = (await initResp.json());
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
        const body = (await resp.json());
        expect(body.error).toBeDefined();
    });
});
// ── loadAuthorizedPeers (disk-based) ───────────────────────────────────────
describe('loadCallerPeers via createApp', () => {
    let peerDir;
    let tmpKeysDir;
    beforeAll(() => {
        // Create temp directories for peer public keys
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-peers-'));
        peerDir = path.join(tmpBase, 'client1');
        fs.mkdirSync(peerDir, { recursive: true });
        tmpKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-keys-'));
        // Save server keys to disk so createApp can load them
        saveKeyBundle(serverKeys, tmpKeysDir);
        // Save one valid peer's public keys
        const serialized = serializeKeyBundle(clientKeys);
        fs.writeFileSync(path.join(peerDir, 'signing.pub.pem'), serialized.signing.publicKey);
        fs.writeFileSync(path.join(peerDir, 'exchange.pub.pem'), serialized.exchange.publicKey);
    });
    afterAll(() => {
        fs.rmSync(path.dirname(peerDir), { recursive: true, force: true });
        fs.rmSync(tmpKeysDir, { recursive: true, force: true });
    });
    it('should load peers from disk and allow authorized handshakes', async () => {
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: tmpKeysDir,
            connectors: [
                {
                    alias: 'disk-test',
                    secrets: { TEST: 'loaded-from-disk' },
                    allowedEndpoints: [],
                },
            ],
            callers: {
                client1: { peerKeyDir: peerDir, connections: ['disk-test'] },
            },
            rateLimitPerMinute: 60,
        };
        // Only pass config — let createApp load keys and peers from disk
        const app = createApp({ config });
        const diskServer = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        try {
            const addr = diskServer.address();
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
            const reply = (await initResp.json());
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
            // Verify we can list routes (confirms the session is usable)
            const request = {
                type: 'proxy_request',
                id: crypto.randomUUID(),
                toolName: 'list_routes',
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
            const decrypted = channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
            expect(decrypted.success).toBe(true);
            const routes = decrypted.result;
            expect(routes).toHaveLength(1);
            expect(routes[0].secretNames).toContain('TEST');
        }
        finally {
            await new Promise((resolve) => {
                diskServer.close(() => resolve());
            });
        }
    });
    it('should handle non-existent peers directory gracefully', () => {
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            callers: {
                ghost: {
                    peerKeyDir: '/tmp/nonexistent-peers-dir-xyz-' + crypto.randomUUID(),
                    connections: [],
                },
            },
            rateLimitPerMinute: 60,
        };
        // Should not throw — loadCallerPeers skips missing dirs
        expect(() => createApp({
            config,
            ownKeys: serverKeys,
            // authorizedPeers not passed, so it'll call loadCallerPeers
        })).not.toThrow();
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
        const reply = (await initResp.json());
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
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName: 'list_routes',
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
// ── Per-caller access control ──────────────────────────────────────────────
describe('Per-caller access control', () => {
    let targetServerX;
    let targetUrlX;
    let targetServerY;
    let targetUrlY;
    let accessServer;
    let accessUrl;
    // Two separate clients with different key pairs
    let client2Keys;
    let client2Pub;
    beforeAll(async () => {
        client2Keys = generateKeyBundle();
        client2Pub = extractPublicKeys(client2Keys);
        // Two target servers
        targetServerX = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ server: 'X', auth: req.headers.authorization ?? null }));
        });
        targetServerY = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ server: 'Y', auth: req.headers.authorization ?? null }));
        });
        await Promise.all([
            new Promise((resolve) => {
                targetServerX.listen(0, '127.0.0.1', () => {
                    const addr = targetServerX.address();
                    targetUrlX = `http://127.0.0.1:${addr.port}`;
                    resolve();
                });
            }),
            new Promise((resolve) => {
                targetServerY.listen(0, '127.0.0.1', () => {
                    const addr = targetServerY.address();
                    targetUrlY = `http://127.0.0.1:${addr.port}`;
                    resolve();
                });
            }),
        ]);
        // Configure: caller "full" gets both connectors, caller "limited" gets only X
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'service-x',
                    name: 'Service X',
                    headers: { Authorization: 'Bearer token-x' },
                    secrets: {},
                    allowedEndpoints: [`${targetUrlX}/**`],
                },
                {
                    alias: 'service-y',
                    name: 'Service Y',
                    headers: { Authorization: 'Bearer token-y' },
                    secrets: {},
                    allowedEndpoints: [`${targetUrlY}/**`],
                },
            ],
            callers: {
                full: { peerKeyDir: '', connections: ['service-x', 'service-y'] },
                limited: { peerKeyDir: '', connections: ['service-x'] },
            },
            rateLimitPerMinute: 60,
        };
        const authorizedPeers = [
            { alias: 'full', keys: clientPub },
            { alias: 'limited', keys: client2Pub },
        ];
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers,
        });
        await new Promise((resolve) => {
            accessServer = app.listen(0, '127.0.0.1', () => {
                const addr = accessServer.address();
                accessUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        await Promise.all([
            new Promise((resolve, reject) => {
                targetServerX.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                targetServerY.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                accessServer.close((err) => (err ? reject(err) : resolve()));
            }),
        ]);
    });
    async function handshakeAs(keys) {
        const initiator = new HandshakeInitiator(keys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${accessUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        expect(initResp.ok).toBe(true);
        const reply = (await initResp.json());
        const sessionKeys = initiator.processReply(reply);
        const channel = new EncryptedChannel(sessionKeys);
        const finishMsg = initiator.createFinish(sessionKeys);
        await fetch(`${accessUrl}/handshake/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': sessionKeys.sessionId,
            },
            body: JSON.stringify(finishMsg),
        });
        return channel;
    }
    async function sendAccessRequest(channel, toolName, toolInput) {
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName,
            toolInput,
            timestamp: Date.now(),
        };
        const encrypted = channel.encryptJSON(request);
        const resp = await fetch(`${accessUrl}/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Session-Id': channel.sessionId,
            },
            body: new Uint8Array(encrypted),
        });
        expect(resp.ok).toBe(true);
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should show different routes for different callers', async () => {
        const fullChannel = await handshakeAs(clientKeys);
        const limitedChannel = await handshakeAs(client2Keys);
        const fullRoutes = await sendAccessRequest(fullChannel, 'list_routes', {});
        const limitedRoutes = await sendAccessRequest(limitedChannel, 'list_routes', {});
        expect(fullRoutes.success).toBe(true);
        expect(limitedRoutes.success).toBe(true);
        const fullList = fullRoutes.result;
        const limitedList = limitedRoutes.result;
        // Full caller sees both connectors
        expect(fullList).toHaveLength(2);
        expect(fullList[0].name).toBe('Service X');
        expect(fullList[1].name).toBe('Service Y');
        // Limited caller sees only service-x
        expect(limitedList).toHaveLength(1);
        expect(limitedList[0].name).toBe('Service X');
    });
    it('should allow full caller to access both services', async () => {
        const channel = await handshakeAs(clientKeys);
        const respX = await sendAccessRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlX}/test`,
            headers: {},
        });
        expect(respX.success).toBe(true);
        expect(respX.result.body.server).toBe('X');
        const respY = await sendAccessRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlY}/test`,
            headers: {},
        });
        expect(respY.success).toBe(true);
        expect(respY.result.body.server).toBe('Y');
    });
    it('should block limited caller from accessing service Y', async () => {
        const channel = await handshakeAs(client2Keys);
        // Service X should work
        const respX = await sendAccessRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlX}/test`,
            headers: {},
        });
        expect(respX.success).toBe(true);
        // Service Y should be blocked
        const respY = await sendAccessRequest(channel, 'http_request', {
            method: 'GET',
            url: `${targetUrlY}/test`,
            headers: {},
        });
        expect(respY.success).toBe(false);
        expect(respY.error).toContain('Endpoint not allowed');
    });
});
// ── Per-caller env overrides ───────────────────────────────────────────────
describe('Per-caller env overrides', () => {
    let echoServer;
    let echoUrl;
    let envServer;
    let envUrl;
    // Three separate clients
    let aliceKeys;
    let alicePub;
    let bobKeys;
    let bobPub;
    let charlieKeys;
    let charliePub;
    const originalEnv = process.env;
    beforeAll(async () => {
        // Set up env vars for the test
        process.env = { ...originalEnv };
        process.env.ALICE_GH_TOKEN = 'ghp_alice';
        process.env.BOB_GH_TOKEN = 'ghp_bob';
        aliceKeys = generateKeyBundle();
        alicePub = extractPublicKeys(aliceKeys);
        bobKeys = generateKeyBundle();
        bobPub = extractPublicKeys(bobKeys);
        charlieKeys = generateKeyBundle();
        charliePub = extractPublicKeys(charlieKeys);
        // Echo server that returns the Authorization header it receives
        echoServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
        });
        await new Promise((resolve) => {
            echoServer.listen(0, '127.0.0.1', () => {
                const addr = echoServer.address();
                echoUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
        // Config: one connector, three callers with different env overrides
        const config = {
            host: '127.0.0.1',
            port: 0,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'api',
                    name: 'Shared API',
                    secrets: { GH_TOKEN: '${GH_TOKEN}' },
                    headers: { Authorization: 'Bearer ${GH_TOKEN}' },
                    allowedEndpoints: [`${echoUrl}/**`],
                },
            ],
            callers: {
                alice: {
                    peerKeyDir: '',
                    connections: ['api'],
                    env: { GH_TOKEN: '${ALICE_GH_TOKEN}' },
                },
                bob: {
                    peerKeyDir: '',
                    connections: ['api'],
                    env: { GH_TOKEN: '${BOB_GH_TOKEN}' },
                },
                charlie: {
                    peerKeyDir: '',
                    connections: ['api'],
                    env: { GH_TOKEN: 'literal-hardcoded-token' },
                },
            },
            rateLimitPerMinute: 60,
        };
        const authorizedPeers = [
            { alias: 'alice', keys: alicePub },
            { alias: 'bob', keys: bobPub },
            { alias: 'charlie', keys: charliePub },
        ];
        const app = createApp({
            config,
            ownKeys: serverKeys,
            authorizedPeers,
        });
        await new Promise((resolve) => {
            envServer = app.listen(0, '127.0.0.1', () => {
                const addr = envServer.address();
                envUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });
    afterAll(async () => {
        process.env = originalEnv;
        await Promise.all([
            new Promise((resolve, reject) => {
                echoServer.close((err) => (err ? reject(err) : resolve()));
            }),
            new Promise((resolve, reject) => {
                envServer.close((err) => (err ? reject(err) : resolve()));
            }),
        ]);
    });
    async function handshakeAs(keys) {
        const initiator = new HandshakeInitiator(keys, serverPub);
        const initMsg = initiator.createInit();
        const initResp = await fetch(`${envUrl}/handshake/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initMsg),
        });
        expect(initResp.ok).toBe(true);
        const reply = (await initResp.json());
        const sessionKeys = initiator.processReply(reply);
        const channel = new EncryptedChannel(sessionKeys);
        const finishMsg = initiator.createFinish(sessionKeys);
        await fetch(`${envUrl}/handshake/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-Id': sessionKeys.sessionId,
            },
            body: JSON.stringify(finishMsg),
        });
        return channel;
    }
    async function sendEnvRequest(channel, toolName, toolInput) {
        const request = {
            type: 'proxy_request',
            id: crypto.randomUUID(),
            toolName,
            toolInput,
            timestamp: Date.now(),
        };
        const encrypted = channel.encryptJSON(request);
        const resp = await fetch(`${envUrl}/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Session-Id': channel.sessionId,
            },
            body: new Uint8Array(encrypted),
        });
        expect(resp.ok).toBe(true);
        return channel.decryptJSON(Buffer.from(await resp.arrayBuffer()));
    }
    it('should give alice her own GitHub token via env redirect', async () => {
        const channel = await handshakeAs(aliceKeys);
        const response = await sendEnvRequest(channel, 'http_request', {
            method: 'GET',
            url: `${echoUrl}/test`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.auth).toBe('Bearer ghp_alice');
    });
    it('should give bob his own GitHub token via env redirect', async () => {
        const channel = await handshakeAs(bobKeys);
        const response = await sendEnvRequest(channel, 'http_request', {
            method: 'GET',
            url: `${echoUrl}/test`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.auth).toBe('Bearer ghp_bob');
    });
    it('should give charlie a literal hardcoded token via env injection', async () => {
        const channel = await handshakeAs(charlieKeys);
        const response = await sendEnvRequest(channel, 'http_request', {
            method: 'GET',
            url: `${echoUrl}/test`,
            headers: {},
        });
        expect(response.success).toBe(true);
        const result = response.result;
        expect(result.body.auth).toBe('Bearer literal-hardcoded-token');
    });
});
// ── Ingestor tools (poll_events / ingestor_status) ──────────────────────
describe('Ingestor tools', () => {
    it('should return empty array from poll_events when no ingestors configured', async () => {
        const { channel } = await performHttpHandshake();
        const response = await sendToolRequest(channel, 'poll_events', {});
        expect(response.success).toBe(true);
        expect(response.result).toEqual([]);
    });
    it('should return empty array from poll_events with connection filter', async () => {
        const { channel } = await performHttpHandshake();
        const response = await sendToolRequest(channel, 'poll_events', {
            connection: 'discord-bot',
        });
        expect(response.success).toBe(true);
        expect(response.result).toEqual([]);
    });
    it('should return empty array from poll_events with after_id cursor', async () => {
        const { channel } = await performHttpHandshake();
        const response = await sendToolRequest(channel, 'poll_events', {
            after_id: 5,
        });
        expect(response.success).toBe(true);
        expect(response.result).toEqual([]);
    });
    it('should return empty array from ingestor_status when no ingestors configured', async () => {
        const { channel } = await performHttpHandshake();
        const response = await sendToolRequest(channel, 'ingestor_status', {});
        expect(response.success).toBe(true);
        expect(response.result).toEqual([]);
    });
});
//# sourceMappingURL=server.e2e.test.js.map