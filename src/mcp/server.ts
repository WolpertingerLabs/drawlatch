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

import { loadProxyConfig } from '../shared/config.js';
import { loadKeyBundle, loadPublicKeys, EncryptedChannel } from '../shared/crypto/index.js';
import {
  HandshakeInitiator,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';

// ── State ──────────────────────────────────────────────────────────────────

let channel: EncryptedChannel | null = null;
let remoteUrl: string;

// ── Handshake ──────────────────────────────────────────────────────────────

async function establishChannel(): Promise<EncryptedChannel> {
  const config = loadProxyConfig();
  remoteUrl = config.remoteUrl;

  // Log which key identity is being used
  const envAlias = process.env.MCP_KEY_ALIAS?.trim();
  if (envAlias) {
    console.error(`[mcp-proxy] Using key alias from MCP_KEY_ALIAS: "${envAlias}"`);
  } else if (config.localKeyAlias) {
    console.error(`[mcp-proxy] Using key alias from config: "${config.localKeyAlias}"`);
  }
  console.error(`[mcp-proxy] Local keys dir: ${config.localKeysDir}`);

  const ownKeys = loadKeyBundle(config.localKeysDir);
  const remotePub = loadPublicKeys(config.remotePublicKeysDir);

  const initiator = new HandshakeInitiator(ownKeys, remotePub);

  // Step 1: Send HandshakeInit
  const initMsg = initiator.createInit();
  const initResp = await fetch(`${remoteUrl}/handshake/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initMsg),
    signal: AbortSignal.timeout(config.connectTimeout),
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
    signal: AbortSignal.timeout(config.connectTimeout),
  });

  if (!finishResp.ok) {
    throw new Error(`Handshake finish failed: ${finishResp.status}`);
  }

  console.error(`[mcp-proxy] Secure channel established (session: ${sessionKeys.sessionId})`);
  return newChannel;
}

async function getChannel(): Promise<EncryptedChannel> {
  channel ??= await establishChannel();
  return channel;
}

// ── Encrypted request/response ─────────────────────────────────────────────

async function sendEncryptedRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<unknown> {
  const ch = await getChannel();
  const config = loadProxyConfig();

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
    signal: AbortSignal.timeout(config.requestTimeout),
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
    throw new Error(response.error ?? 'Remote server returned failure');
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
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'secure_request',
  "Make an authenticated HTTP request through the encrypted proxy. Route-level headers (e.g., Authorization) are injected automatically by the server — do not send them yourself. You may use ${VAR_NAME} placeholders for other secrets in the URL, headers, or body — they are resolved server-side using the matched route's secrets and never exposed to the client.",
  {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('HTTP method'),
    url: z.string().describe('Full URL, may contain ${VAR} placeholders'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Request headers, may contain ${VAR} placeholders'),
    body: z.any().optional().describe('Request body (object for JSON, string for raw)'),
  },
  async ({ method, url, headers, body }) => {
    try {
      const result = await sendEncryptedRequest('http_request', {
        method,
        url,
        headers: headers ?? {},
        body,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * List all available routes from the remote server with full metadata.
 * Returns route names, descriptions, docs links, endpoint patterns,
 * secret names (not values), and auto-injected header names.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_routes',
  'List all available routes on the remote server. Returns metadata (name, description, docs link), allowed endpoint patterns, available secret placeholder names (not values), and auto-injected header names for each route. Use this to discover which APIs are available and how to call them.',
  // Empty schema — no input needed
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_routes', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Poll for new events from ingestors on the remote server.
 * Returns events received from real-time sources (Discord Gateway, webhooks, etc.)
 * since the last poll cursor.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'poll_events',
  'Poll for new events from ingestors (Discord messages, GitHub webhooks, etc.). Returns events received since the given cursor. Pass after_id from the last event you received to get only new events. Omit connection to get events from all ingestors.',
  {
    connection: z
      .string()
      .optional()
      .describe('Connection alias to poll (e.g., "discord-bot"). Omit for all.'),
    after_id: z
      .number()
      .optional()
      .describe('Return events with id > after_id. Omit or -1 for all buffered events.'),
  },
  async ({ connection, after_id }) => {
    try {
      const result = await sendEncryptedRequest('poll_events', {
        connection,
        after_id,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Get the status of all active ingestors for this caller.
 * Shows connection state, buffer sizes, event counts, and any errors.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'ingestor_status',
  'Get the status of all active ingestors for this caller. Shows connection state, buffer sizes, event counts, and any errors.',
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('ingestor_status', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Test connectivity for a specific connection by running a pre-configured,
 * non-destructive read-only request against its API.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'test_connection',
  'Test connectivity to a specific connection by making a non-destructive read-only request. Verifies that API credentials are valid. Returns success/failure with status details.',
  {
    connection: z.string().describe('Connection alias to test (e.g., "github", "discord-bot")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('test_connection', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Test event listener / ingestor configuration for a specific connection.
 * Verifies credentials and listener parameters are correct.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'test_ingestor',
  'Test event listener configuration for a connection. Verifies credentials and listener parameters are correct without starting the full listener. Returns success/failure with details.',
  {
    connection: z.string().describe('Connection alias to test listener for (e.g., "discord-bot")'),
  },
  async ({ connection }) => {
    try {
      const result = await sendEncryptedRequest('test_ingestor', { connection });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * List listener configuration schemas for all connections with configurable event listeners.
 * Returns field schemas that UIs can use to render configuration forms.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'list_listener_configs',
  'List configurable event listener schemas for all connections. Returns field definitions (type, label, options, defaults) that can be used to render configuration forms.',
  { _: z.string().optional().describe('unused') },
  async () => {
    try {
      const result = await sendEncryptedRequest('list_listener_configs', {});
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Resolve dynamic options for a listener configuration field by fetching
 * them from the external API (e.g., list of Trello boards, Discord guilds).
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'resolve_listener_options',
  'Fetch dynamic options for a listener configuration field. Some fields (like Trello boards) require an API call to populate their options list.',
  {
    connection: z.string().describe('Connection alias (e.g., "trello")'),
    paramKey: z.string().describe('The field key to resolve options for (e.g., "boardId")'),
  },
  async ({ connection, paramKey }) => {
    try {
      const result = await sendEncryptedRequest('resolve_listener_options', { connection, paramKey });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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
 * Start, stop, or restart an event listener for a specific connection.
 * Controls the lifecycle of ingestors at runtime without restarting the server.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- registerTool is not available in this SDK version
server.tool(
  'control_listener',
  'Start, stop, or restart an event listener for a connection. Stopping a listener pauses event collection; starting resumes it. Use restart after configuration changes.',
  {
    connection: z.string().describe('Connection alias (e.g., "discord-bot")'),
    action: z.enum(['start', 'stop', 'restart']).describe('Lifecycle action to perform'),
  },
  async ({ connection, action }) => {
    try {
      const result = await sendEncryptedRequest('control_listener', { connection, action });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
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

main().catch((err: unknown) => {
  console.error('[mcp-proxy] Fatal error:', err);
  process.exit(1);
});
