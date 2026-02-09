/**
 * Application-layer message types exchanged over the encrypted channel.
 *
 * All messages are JSON-serialized, encrypted with AES-256-GCM, and sent
 * as hex-encoded payloads over the HTTP transport.
 */

/** Request from MCP proxy → remote server */
export interface ProxyRequest {
  type: 'proxy_request';
  /** Unique request ID for correlation */
  id: string;
  /** The tool name the MCP client invoked */
  toolName: string;
  /** The tool's input parameters */
  toolInput: Record<string, unknown>;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

/** Response from remote server → MCP proxy */
export interface ProxyResponse {
  type: 'proxy_response';
  /** Correlates to ProxyRequest.id */
  id: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** The result payload (tool output) */
  result?: unknown;
  /** Error message if success=false */
  error?: string;
  /** Timestamp */
  timestamp: number;
}

/** Ping to keep the connection alive / verify the channel */
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/** Pong response */
export interface PongMessage {
  type: 'pong';
  timestamp: number;
  /** Echo back the ping timestamp for RTT measurement */
  echoTimestamp: number;
}

export type AppMessage = ProxyRequest | ProxyResponse | PingMessage | PongMessage;
