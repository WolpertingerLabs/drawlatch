/**
 * Remote Secure Server — the secrets-holding side.
 *
 * Runs as an HTTP server (localhost or remote). Holds secrets and only
 * communicates through encrypted channels established via mutual auth.
 *
 * This server:
 *   - Authenticates incoming MCP proxy clients via Ed25519 signatures
 *   - Establishes encrypted channels via X25519 ECDH + AES-256-GCM
 *   - Receives encrypted tool requests, injects secrets, executes, encrypts results
 *   - Never exposes secrets in plaintext over the wire
 *   - Maintains an audit log of all operations
 *   - Rate-limits requests per session
 */
import 'dotenv/config';
import { type RemoteServerConfig, type ResolvedRoute } from '../shared/config.js';
import { EncryptedChannel, type PublicKeyBundle } from '../shared/crypto/index.js';
import { HandshakeResponder, type HandshakeInit } from '../shared/protocol/index.js';
import { IngestorManager } from './ingestors/index.js';
/** An authorized peer with its alias and optional display name */
export interface AuthorizedPeer {
    /** Caller alias — the key from the callers config object */
    alias: string;
    /** Human-readable name for audit logs */
    name?: string;
    /** The peer's public keys (signing + exchange) */
    keys: PublicKeyBundle;
}
export interface Session {
    channel: EncryptedChannel;
    /** Caller alias for this session (from the matched AuthorizedPeer) */
    callerAlias: string;
    /** Per-caller resolved routes for this session */
    resolvedRoutes: ResolvedRoute[];
    createdAt: number;
    lastActivity: number;
    requestCount: number;
    /** Requests in the current rate-limit window */
    windowRequests: number;
    windowStart: number;
}
export interface PendingHandshake {
    responder: HandshakeResponder;
    init: HandshakeInit;
    createdAt: number;
}
export declare function isEndpointAllowed(url: string, patterns: string[]): boolean;
export { resolvePlaceholders } from '../shared/config.js';
/**
 * Find the first route whose allowedEndpoints match the given URL.
 * Routes with empty allowedEndpoints match nothing.
 */
export declare function matchRoute(url: string, routes: ResolvedRoute[]): ResolvedRoute | null;
export declare function checkRateLimit(session: Pick<Session, 'windowRequests' | 'windowStart'>, limit: number): boolean;
export declare const SESSION_TTL: number;
export declare const HANDSHAKE_TTL: number;
export declare function cleanupSessions(sessionsMap: Map<string, Pick<Session, 'lastActivity'>>, pendingMap: Map<string, Pick<PendingHandshake, 'createdAt'>>, now?: number): {
    expiredSessions: string[];
    expiredHandshakes: string[];
};
/** Context passed to every tool handler, providing caller identity and shared services. */
export interface ToolContext {
    /** The caller alias for the session making this request. */
    callerAlias: string;
    /** The shared ingestor manager (for poll_events / ingestor_status). */
    ingestorManager: IngestorManager;
}
/** Options for creating the app — allows dependency injection for tests */
export interface CreateAppOptions {
    /** Override config instead of loading from disk */
    config?: RemoteServerConfig;
    /** Override key bundle instead of loading from disk */
    ownKeys?: import('../shared/crypto/index.js').KeyBundle;
    /** Override authorized peers instead of loading from disk */
    authorizedPeers?: AuthorizedPeer[];
    /** Override the ingestor manager instead of creating one from config */
    ingestorManager?: IngestorManager;
}
export declare function createApp(options?: CreateAppOptions): import("express-serve-static-core").Express;
//# sourceMappingURL=server.d.ts.map