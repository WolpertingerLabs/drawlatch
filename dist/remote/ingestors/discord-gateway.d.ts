/**
 * Discord Gateway (WebSocket) ingestor.
 *
 * Connects to the Discord Gateway v10 and streams real-time events
 * (messages, reactions, presence updates, etc.) into the ring buffer.
 *
 * Implements the full Gateway lifecycle:
 *   Hello → Identify → Ready → Dispatch loop
 *   Heartbeat with jitter, ACK tracking, zombie detection
 *   Resume support (session_id + sequence)
 *   Exponential backoff reconnection
 *
 * Uses the native WebSocket API (Node 22+).
 *
 * @see https://discord.com/developers/docs/events/gateway
 */
import { BaseIngestor } from './base-ingestor.js';
import type { WebSocketIngestorConfig } from './types.js';
export declare const DiscordIntents: {
    readonly GUILDS: number;
    readonly GUILD_MEMBERS: number;
    readonly GUILD_MODERATION: number;
    readonly GUILD_EXPRESSIONS: number;
    readonly GUILD_INTEGRATIONS: number;
    readonly GUILD_WEBHOOKS: number;
    readonly GUILD_INVITES: number;
    readonly GUILD_VOICE_STATES: number;
    readonly GUILD_PRESENCES: number;
    readonly GUILD_MESSAGES: number;
    readonly GUILD_MESSAGE_REACTIONS: number;
    readonly GUILD_MESSAGE_TYPING: number;
    readonly DIRECT_MESSAGES: number;
    readonly DIRECT_MESSAGE_REACTIONS: number;
    readonly DIRECT_MESSAGE_TYPING: number;
    readonly MESSAGE_CONTENT: number;
    readonly GUILD_SCHEDULED_EVENTS: number;
    readonly AUTO_MODERATION_CONFIGURATION: number;
    readonly AUTO_MODERATION_EXECUTION: number;
};
export declare class DiscordGatewayIngestor extends BaseIngestor {
    private readonly wsConfig;
    private ws;
    private heartbeatTimer;
    private heartbeatJitterTimer;
    private heartbeatAcked;
    /** Discord sequence number — tracks the last dispatch event received. */
    private sequenceNumber;
    /** Discord session ID — needed for RESUME. */
    private discordSessionId;
    /** Resume Gateway URL — provided in READY, used for reconnection. */
    private resumeGatewayUrl;
    private reconnectAttempts;
    private readonly maxReconnectAttempts;
    private reconnectTimer;
    private readonly gatewayUrl;
    private readonly intents;
    private readonly eventFilter;
    constructor(connectionAlias: string, secrets: Record<string, string>, wsConfig: WebSocketIngestorConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private connect;
    private handlePayload;
    private handleHello;
    private sendIdentify;
    private sendResume;
    private handleDispatch;
    private handleInvalidSession;
    private startHeartbeat;
    private sendHeartbeat;
    private handleClose;
    private initiateReconnect;
    private scheduleReconnect;
    private send;
    private clearAllTimers;
}
//# sourceMappingURL=discord-gateway.d.ts.map