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
// ── Discord Gateway opcodes ─────────────────────────────────────────────
const GatewayOp = {
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
};
// ── Discord intent flags ────────────────────────────────────────────────
export const DiscordIntents = {
    GUILDS: 1 << 0,
    GUILD_MEMBERS: 1 << 1,
    GUILD_MODERATION: 1 << 2,
    GUILD_EXPRESSIONS: 1 << 3,
    GUILD_INTEGRATIONS: 1 << 4,
    GUILD_WEBHOOKS: 1 << 5,
    GUILD_INVITES: 1 << 6,
    GUILD_VOICE_STATES: 1 << 7,
    GUILD_PRESENCES: 1 << 8,
    GUILD_MESSAGES: 1 << 9,
    GUILD_MESSAGE_REACTIONS: 1 << 10,
    GUILD_MESSAGE_TYPING: 1 << 11,
    DIRECT_MESSAGES: 1 << 12,
    DIRECT_MESSAGE_REACTIONS: 1 << 13,
    DIRECT_MESSAGE_TYPING: 1 << 14,
    MESSAGE_CONTENT: 1 << 15,
    GUILD_SCHEDULED_EVENTS: 1 << 16,
    AUTO_MODERATION_CONFIGURATION: 1 << 20,
    AUTO_MODERATION_EXECUTION: 1 << 21,
};
/** Default intents: guilds + guild messages + DMs (no privileged intents). */
const DEFAULT_INTENTS = DiscordIntents.GUILDS | DiscordIntents.GUILD_MESSAGES | DiscordIntents.DIRECT_MESSAGES;
// Discord close codes that are non-recoverable (do NOT reconnect)
const NON_RECOVERABLE_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Discord close codes that invalidate the session (must re-IDENTIFY, not RESUME)
const INVALIDATE_SESSION_CLOSE_CODES = new Set([4007, 4009]);
// ── Discord Gateway ingestor ────────────────────────────────────────────
export class DiscordGatewayIngestor extends BaseIngestor {
    wsConfig;
    ws = null;
    heartbeatTimer = null;
    heartbeatJitterTimer = null;
    heartbeatAcked = true;
    /** Discord sequence number — tracks the last dispatch event received. */
    sequenceNumber = null;
    /** Discord session ID — needed for RESUME. */
    discordSessionId = null;
    /** Resume Gateway URL — provided in READY, used for reconnection. */
    resumeGatewayUrl = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 10;
    reconnectTimer = null;
    gatewayUrl;
    intents;
    eventFilter;
    constructor(connectionAlias, secrets, wsConfig) {
        super(connectionAlias, 'websocket', secrets);
        this.wsConfig = wsConfig;
        this.gatewayUrl = wsConfig.gatewayUrl;
        this.intents = wsConfig.intents ?? DEFAULT_INTENTS;
        this.eventFilter = wsConfig.eventFilter ?? [];
    }
    start() {
        this.state = 'starting';
        this.connect(this.gatewayUrl);
        return Promise.resolve();
    }
    stop() {
        this.state = 'stopped';
        this.clearAllTimers();
        if (this.ws) {
            this.ws.close(1000, 'Shutting down');
            this.ws = null;
        }
        return Promise.resolve();
    }
    // ── WebSocket connection ────────────────────────────────────────────
    connect(url) {
        try {
            this.ws = new WebSocket(url);
        }
        catch (err) {
            this.state = 'error';
            this.errorMessage = `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[discord-gw] ${this.errorMessage} (${this.connectionAlias})`);
            return;
        }
        this.ws.addEventListener('open', () => {
            console.log(`[discord-gw] Connected to Gateway for ${this.connectionAlias}`);
        });
        this.ws.addEventListener('message', (event) => {
            try {
                const data = typeof event.data === 'string' ? event.data : String(event.data);
                const payload = JSON.parse(data);
                this.handlePayload(payload);
            }
            catch (err) {
                console.error(`[discord-gw] Failed to parse Gateway message:`, err);
            }
        });
        this.ws.addEventListener('close', (event) => {
            console.log(`[discord-gw] Connection closed for ${this.connectionAlias}: ${event.code} ${event.reason}`);
            this.clearAllTimers();
            if (this.state !== 'stopped') {
                this.handleClose(event.code);
            }
        });
        this.ws.addEventListener('error', () => {
            // The 'close' event always follows 'error', so we handle reconnection there.
            console.error(`[discord-gw] WebSocket error for ${this.connectionAlias}`);
        });
    }
    // ── Gateway payload dispatch ────────────────────────────────────────
    handlePayload(payload) {
        switch (payload.op) {
            case GatewayOp.HELLO:
                this.handleHello(payload.d);
                break;
            case GatewayOp.HEARTBEAT_ACK:
                this.heartbeatAcked = true;
                break;
            case GatewayOp.HEARTBEAT:
                // Server requested an immediate heartbeat
                this.sendHeartbeat();
                break;
            case GatewayOp.DISPATCH:
                this.handleDispatch(payload);
                break;
            case GatewayOp.RECONNECT:
                console.log(`[discord-gw] Server requested reconnect for ${this.connectionAlias}`);
                this.initiateReconnect();
                break;
            case GatewayOp.INVALID_SESSION:
                this.handleInvalidSession(payload.d);
                break;
        }
    }
    // ── Hello → Identify / Resume ───────────────────────────────────────
    handleHello(data) {
        this.startHeartbeat(data.heartbeat_interval);
        if (this.discordSessionId && this.sequenceNumber !== null) {
            this.sendResume();
        }
        else {
            this.sendIdentify();
        }
    }
    sendIdentify() {
        const token = this.secrets.DISCORD_BOT_TOKEN;
        if (!token) {
            this.state = 'error';
            this.errorMessage = 'DISCORD_BOT_TOKEN not found in resolved secrets';
            console.error(`[discord-gw] ${this.errorMessage} (${this.connectionAlias})`);
            return;
        }
        this.send({
            op: GatewayOp.IDENTIFY,
            d: {
                token,
                intents: this.intents,
                properties: {
                    os: 'linux',
                    browser: 'mcp-secure-proxy',
                    device: 'mcp-secure-proxy',
                },
            },
        });
    }
    sendResume() {
        const token = this.secrets.DISCORD_BOT_TOKEN;
        this.send({
            op: GatewayOp.RESUME,
            d: {
                token,
                session_id: this.discordSessionId,
                seq: this.sequenceNumber,
            },
        });
    }
    // ── Dispatch (op 0) events ──────────────────────────────────────────
    handleDispatch(payload) {
        // Track sequence number
        if (payload.s !== null) {
            this.sequenceNumber = payload.s;
        }
        const eventName = payload.t;
        if (!eventName)
            return;
        // Handle READY — capture session info for resume
        if (eventName === 'READY') {
            const readyData = payload.d;
            this.discordSessionId = readyData.session_id;
            this.resumeGatewayUrl = readyData.resume_gateway_url;
            this.state = 'connected';
            this.reconnectAttempts = 0;
            console.log(`[discord-gw] Ready for ${this.connectionAlias} (session: ${this.discordSessionId})`);
        }
        // Handle RESUMED
        if (eventName === 'RESUMED') {
            this.state = 'connected';
            this.reconnectAttempts = 0;
            console.log(`[discord-gw] Resumed for ${this.connectionAlias}`);
        }
        // Apply event filter (empty filter = capture all)
        if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventName)) {
            return;
        }
        // Buffer the event
        this.pushEvent(eventName, payload.d);
    }
    // ── Invalid Session ─────────────────────────────────────────────────
    handleInvalidSession(resumable) {
        if (resumable) {
            // Can resume — wait a random 1-5 seconds then resume
            const delay = 1000 + Math.random() * 4000;
            setTimeout(() => this.sendResume(), delay);
        }
        else {
            // Cannot resume — clear session state and re-identify
            this.discordSessionId = null;
            this.sequenceNumber = null;
            const delay = 1000 + Math.random() * 4000;
            setTimeout(() => this.sendIdentify(), delay);
        }
    }
    // ── Heartbeat ───────────────────────────────────────────────────────
    startHeartbeat(intervalMs) {
        this.clearAllTimers();
        // First heartbeat after random jitter (0..intervalMs)
        const jitter = Math.random() * intervalMs;
        this.heartbeatJitterTimer = setTimeout(() => {
            this.heartbeatJitterTimer = null;
            this.sendHeartbeat();
            this.heartbeatTimer = setInterval(() => {
                if (!this.heartbeatAcked) {
                    // Zombie connection — server stopped responding
                    console.log(`[discord-gw] Heartbeat not ACKed, reconnecting ${this.connectionAlias}`);
                    this.initiateReconnect();
                    return;
                }
                this.heartbeatAcked = false;
                this.sendHeartbeat();
            }, intervalMs);
        }, jitter);
    }
    sendHeartbeat() {
        this.send({ op: GatewayOp.HEARTBEAT, d: this.sequenceNumber });
    }
    // ── Reconnection ───────────────────────────────────────────────────
    handleClose(code) {
        // Non-recoverable codes: stop permanently
        if (NON_RECOVERABLE_CLOSE_CODES.has(code)) {
            this.state = 'error';
            this.errorMessage = `Non-recoverable Gateway close code: ${code}`;
            console.error(`[discord-gw] ${this.errorMessage} (${this.connectionAlias})`);
            return;
        }
        // Codes that invalidate the session: clear state so we re-IDENTIFY
        if (INVALIDATE_SESSION_CLOSE_CODES.has(code)) {
            this.discordSessionId = null;
            this.sequenceNumber = null;
        }
        this.scheduleReconnect();
    }
    initiateReconnect() {
        this.clearAllTimers();
        if (this.ws) {
            // Close with code 4000 to signal intentional reconnect to Discord
            this.ws.close(4000, 'Reconnecting');
            this.ws = null;
        }
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.state = 'error';
            this.errorMessage = `Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`;
            console.error(`[discord-gw] ${this.errorMessage} (${this.connectionAlias})`);
            return;
        }
        this.state = 'reconnecting';
        this.reconnectAttempts++;
        const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
        console.log(`[discord-gw] Reconnecting ${this.connectionAlias} in ${backoff}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            const url = this.resumeGatewayUrl ?? this.gatewayUrl;
            this.connect(url);
        }, backoff);
    }
    // ── Helpers ─────────────────────────────────────────────────────────
    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
    clearAllTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.heartbeatJitterTimer) {
            clearTimeout(this.heartbeatJitterTimer);
            this.heartbeatJitterTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
//# sourceMappingURL=discord-gateway.js.map