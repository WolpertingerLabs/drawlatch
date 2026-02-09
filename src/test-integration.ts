#!/usr/bin/env node
/**
 * Integration test: exercises the full handshake + encrypted request flow.
 *
 * Starts the remote server, performs a handshake from the proxy side,
 * sends encrypted requests, verifies responses.
 */

import { loadConfig } from './config.js';
import {
  loadKeyBundle,
  loadPublicKeys,
  EncryptedChannel,
} from './crypto/index.js';
import {
  HandshakeInitiator,
  type ProxyRequest,
  type ProxyResponse,
} from './protocol/index.js';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let serverProcess: ChildProcess | null = null;
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function waitForServer(url: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server did not start in time');
}

async function startServer(): Promise<void> {
  const serverPath = path.join(__dirname, '..', 'dist', 'remote-server.js');
  serverProcess = spawn('node', [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (data: Buffer) => {
    // Show server logs prefixed
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`    [server] ${line}`);
    }
  });
}

async function testHandshakeAndRequest(): Promise<void> {
  const config = loadConfig();
  const remoteUrl = config.proxy.remoteUrl;

  const ownKeys = loadKeyBundle(config.proxy.localKeysDir);
  const remotePub = loadPublicKeys(config.proxy.remotePublicKeysDir);

  // ── Handshake ──────────────────────────────────────────────────────────

  console.log('\n── Handshake ──');

  const initiator = new HandshakeInitiator(ownKeys, remotePub);
  const initMsg = initiator.createInit();

  assert(initMsg.type === 'handshake_init', 'Init message has correct type');
  assert(initMsg.version === 1, 'Protocol version is 1');

  // Send init
  const initResp = await fetch(`${remoteUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initMsg),
  });
  assert(initResp.ok, `Handshake init accepted (${initResp.status})`);

  const reply = await initResp.json();
  assert(reply.type === 'handshake_reply', 'Got handshake reply');
  assert(typeof reply.ephemeralPubKey === 'string', 'Reply contains ephemeral public key');
  assert(typeof reply.nonceR === 'string', 'Reply contains responder nonce');
  assert(typeof reply.signature === 'string', 'Reply contains signature');

  // Process reply and derive keys
  const sessionKeys = initiator.processReply(reply);
  assert(typeof sessionKeys.sessionId === 'string', `Session ID derived: ${sessionKeys.sessionId.substring(0, 12)}...`);

  const channel = new EncryptedChannel(sessionKeys);

  // Send finish
  const finishMsg = initiator.createFinish(sessionKeys);
  const finishResp = await fetch(`${remoteUrl}/handshake/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionKeys.sessionId,
    },
    body: JSON.stringify(finishMsg),
  });
  assert(finishResp.ok, `Handshake finish accepted (${finishResp.status})`);

  const finishResult = await finishResp.json();
  assert(finishResult.status === 'established', 'Session established');

  // ── Encrypted requests ─────────────────────────────────────────────────

  console.log('\n── Encrypted Requests ──');

  // Test: list_secrets
  const listReq: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName: 'list_secrets',
    toolInput: {},
    timestamp: Date.now(),
  };

  const listEncrypted = channel.encryptJSON(listReq);
  const listResp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': channel.sessionId,
    },
    body: new Uint8Array(listEncrypted),
  });
  assert(listResp.ok, `list_secrets request accepted (${listResp.status})`);

  const listDecrypted = channel.decryptJSON<ProxyResponse>(
    Buffer.from(await listResp.arrayBuffer()),
  );
  assert(listDecrypted.success === true, 'list_secrets succeeded');
  assert(Array.isArray(listDecrypted.result), 'Result is an array');
  const secretNames = listDecrypted.result as string[];
  assert(secretNames.includes('TEST_SECRET'), 'TEST_SECRET is listed');
  assert(secretNames.includes('API_KEY'), 'API_KEY is listed');

  // Test: get_secret
  const getReq: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName: 'get_secret',
    toolInput: { name: 'TEST_SECRET' },
    timestamp: Date.now(),
  };

  const getEncrypted = channel.encryptJSON(getReq);
  const getResp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': channel.sessionId,
    },
    body: new Uint8Array(getEncrypted),
  });
  assert(getResp.ok, `get_secret request accepted (${getResp.status})`);

  const getDecrypted = channel.decryptJSON<ProxyResponse>(
    Buffer.from(await getResp.arrayBuffer()),
  );
  assert(getDecrypted.success === true, 'get_secret succeeded');
  assert(getDecrypted.result === 'hello-from-the-vault', `Secret value correct: "${getDecrypted.result}"`);

  // Test: encrypted counter monotonicity (replay protection)
  console.log('\n── Security checks ──');

  // Re-send the same encrypted payload (replay attack)
  const replayResp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': channel.sessionId,
    },
    body: new Uint8Array(getEncrypted), // same payload
  });
  // Should fail because counter won't match
  if (replayResp.ok) {
    const replayData = channel.decryptJSON<ProxyResponse>(
      Buffer.from(await replayResp.arrayBuffer()),
    );
    assert(replayData.success === false, 'Replay attack correctly rejected');
  } else {
    assert(replayResp.status === 500, `Replay attack rejected at transport level (${replayResp.status})`);
  }

  // Test: unknown session
  const unknownResp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': 'nonexistent-session-id',
    },
    body: new Uint8Array(Buffer.from('garbage')),
  });
  assert(unknownResp.status === 401, `Unknown session rejected (${unknownResp.status})`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        MCP Secure Proxy — Integration Test             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  console.log('\nStarting remote server...');
  await startServer();

  try {
    await waitForServer('http://127.0.0.1:9999');
    console.log('  Server ready.');

    await testHandshakeAndRequest();

    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`═══════════════════════════════════════════════\n`);
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest failed:', err);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
