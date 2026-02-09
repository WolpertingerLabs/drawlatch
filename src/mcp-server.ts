/**
 * MCP Proxy Server — the local side.
 *
 * Claude Code spawns this as a child process (stdio transport).
 * It exposes MCP tools, encrypts requests, forwards them to the remote
 * secure server over HTTP, decrypts responses, and returns them to Claude.
 *
 * The proxy holds NO secrets. It only has:
 *   - Its own Ed25519 + X25519 keypair (for authentication + encryption)
 *   - The remote server's public keys (for verifying the remote's identity)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';

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

// ── State ──────────────────────────────────────────────────────────────────

let channel: EncryptedChannel | null = null;
let remoteUrl: string;

// ── Handshake ──────────────────────────────────────────────────────────────

async function establishChannel(): Promise<EncryptedChannel> {
  const config = loadConfig();
  remoteUrl = config.proxy.remoteUrl;

  const ownKeys = loadKeyBundle(config.proxy.localKeysDir);
  const remotePub = loadPublicKeys(config.proxy.remotePublicKeysDir);

  const initiator = new HandshakeInitiator(ownKeys, remotePub);

  // Step 1: Send HandshakeInit
  const initMsg = initiator.createInit();
  const initResp = await fetch(`${remoteUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initMsg),
    signal: AbortSignal.timeout(config.proxy.connectTimeout),
  });

  if (!initResp.ok) {
    const errText = await initResp.text();
    throw new Error(`Handshake init failed: ${initResp.status} ${errText}`);
  }

  const reply = await initResp.json();

  // Step 3: Process reply and derive keys
  const sessionKeys = initiator.processReply(reply);
  const newChannel = new EncryptedChannel(sessionKeys);

  // Step 3b: Send encrypted "finish" to prove we derived the right keys
  const finishMsg = initiator.createFinish(sessionKeys);
  const finishResp = await fetch(`${remoteUrl}/handshake/finish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionKeys.sessionId,
    },
    body: JSON.stringify(finishMsg),
    signal: AbortSignal.timeout(config.proxy.connectTimeout),
  });

  if (!finishResp.ok) {
    throw new Error(`Handshake finish failed: ${finishResp.status}`);
  }

  console.error(`[mcp-proxy] Secure channel established (session: ${sessionKeys.sessionId})`);
  return newChannel;
}

async function getChannel(): Promise<EncryptedChannel> {
  if (!channel) {
    channel = await establishChannel();
  }
  return channel;
}

// ── Encrypted request/response ─────────────────────────────────────────────

async function sendEncryptedRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<unknown> {
  const ch = await getChannel();
  const config = loadConfig();

  const request: ProxyRequest = {
    type: 'proxy_request',
    id: crypto.randomUUID(),
    toolName,
    toolInput,
    timestamp: Date.now(),
  };

  // Encrypt the entire request
  const encrypted = ch.encryptJSON(request);

  const resp = await fetch(`${remoteUrl}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Session-Id': ch.sessionId,
    },
    body: new Uint8Array(encrypted),
    signal: AbortSignal.timeout(config.proxy.requestTimeout),
  });

  if (!resp.ok) {
    // If session expired, re-establish
    if (resp.status === 401) {
      console.error('[mcp-proxy] Session expired, re-establishing...');
      channel = null;
      return sendEncryptedRequest(toolName, toolInput);
    }
    throw new Error(`Request failed: ${resp.status} ${await resp.text()}`);
  }

  // Decrypt the response
  const encryptedResponse = Buffer.from(await resp.arrayBuffer());
  const response = ch.decryptJSON<ProxyResponse>(encryptedResponse);

  if (!response.success) {
    throw new Error(response.error || 'Remote server returned failure');
  }

  return response.result;
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'secure-proxy',
  version: '1.0.0',
});

/**
 * Generic HTTP request tool — similar to the api-proxy but all traffic is
 * encrypted end-to-end. The remote server resolves secret placeholders.
 */
server.tool(
  'secure_request',
  'Make an authenticated HTTP request through the encrypted proxy. Use ${VAR_NAME} placeholders for secrets — they are resolved server-side and never exposed to the client.',
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
    url: z.string().describe('Full URL, may contain ${VAR} placeholders'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers, may contain ${VAR} placeholders'),
    body: z.any().optional().describe('Request body (object for JSON, string for raw)'),
  },
  async ({ method, url, headers, body }) => {
    try {
      const result = await sendEncryptedRequest('http_request', {
        method,
        url,
        headers: headers || {},
        body,
      });

      return {
        content: [{
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * Fetch a secret value by name. The secret is resolved on the remote server
 * and returned encrypted. Useful when you need a secret as a standalone value
 * rather than injected into an HTTP request.
 */
server.tool(
  'get_secret',
  'Retrieve a secret value by name from the secure remote store. The value is encrypted in transit and never stored locally.',
  {
    name: z.string().describe('The secret name to retrieve'),
  },
  async ({ name }) => {
    try {
      const result = await sendEncryptedRequest('get_secret', { name });
      return {
        content: [{
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

/**
 * List available secret names (not values) from the remote store.
 */
server.tool(
  'list_secrets',
  'List the names of available secrets on the remote server. Does not return secret values.',
  // Empty schema — no input needed
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_secrets', {});
      return {
        content: [{
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-proxy] MCP Secure Proxy server started (stdio transport)');
}

main().catch((err) => {
  console.error('[mcp-proxy] Fatal error:', err);
  process.exit(1);
});
