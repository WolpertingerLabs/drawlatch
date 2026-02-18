/**
 * IngestorManager — owns and manages the lifecycle of all ingestor instances.
 *
 * Keyed by `callerAlias:connectionAlias`, so each caller gets its own
 * ingestor instance (with its own secrets, buffer, and connection state).
 * Multiple sessions from the same caller share the same ingestor/buffer.
 *
 * The manager is created once when the remote server starts, and provides
 * event retrieval and status methods used by the `poll_events` and
 * `ingestor_status` tool handlers.
 */
import { resolveCallerRoutes, resolveRoutes, resolveSecrets, } from '../../shared/config.js';
import { DiscordGatewayIngestor } from './discord-gateway.js';
export class IngestorManager {
    config;
    /** Active ingestor instances, keyed by `callerAlias:connectionAlias`. */
    ingestors = new Map();
    constructor(config) {
        this.config = config;
    }
    /**
     * Start ingestors for all callers whose connections have an `ingestor` config.
     * Called once when the remote server starts listening.
     */
    async startAll() {
        for (const [callerAlias, callerConfig] of Object.entries(this.config.callers)) {
            // Resolve routes for this caller (raw + resolved)
            const rawRoutes = resolveCallerRoutes(this.config, callerAlias);
            const callerEnvResolved = resolveSecrets(callerConfig.env ?? {});
            const resolvedRoutes = resolveRoutes(rawRoutes, callerEnvResolved);
            for (let i = 0; i < rawRoutes.length; i++) {
                const rawRoute = rawRoutes[i];
                const resolvedRoute = resolvedRoutes[i];
                const connectionAlias = callerConfig.connections[i];
                // Skip connections without an ingestor config
                if (!rawRoute.ingestor)
                    continue;
                const key = `${callerAlias}:${connectionAlias}`;
                if (this.ingestors.has(key))
                    continue;
                const ingestor = this.createIngestor(connectionAlias, rawRoute.ingestor, resolvedRoute.secrets);
                if (ingestor) {
                    this.ingestors.set(key, ingestor);
                    console.log(`[ingestor] Starting ${rawRoute.ingestor.type} ingestor for ${key}`);
                    try {
                        await ingestor.start();
                    }
                    catch (err) {
                        console.error(`[ingestor] Failed to start ${key}:`, err);
                    }
                }
            }
        }
        const count = this.ingestors.size;
        if (count > 0) {
            console.log(`[ingestor] ${count} ingestor(s) started`);
        }
    }
    /**
     * Stop all running ingestors. Called during graceful shutdown.
     */
    async stopAll() {
        const stops = Array.from(this.ingestors.entries()).map(async ([key, ingestor]) => {
            console.log(`[ingestor] Stopping ${key}`);
            try {
                await ingestor.stop();
            }
            catch (err) {
                console.error(`[ingestor] Error stopping ${key}:`, err);
            }
        });
        await Promise.all(stops);
        this.ingestors.clear();
    }
    /**
     * Get events for a specific caller and connection.
     * @param callerAlias  The caller whose events to retrieve.
     * @param connectionAlias  The connection to filter by.
     * @param afterId  Return events with id > afterId. Pass -1 for all.
     */
    getEvents(callerAlias, connectionAlias, afterId = -1) {
        const key = `${callerAlias}:${connectionAlias}`;
        const ingestor = this.ingestors.get(key);
        if (!ingestor)
            return [];
        return ingestor.getEvents(afterId);
    }
    /**
     * Get events across all ingestors for a caller, sorted chronologically.
     * @param callerAlias  The caller whose events to retrieve.
     * @param afterId  Return events with id > afterId. Pass -1 for all.
     */
    getAllEvents(callerAlias, afterId = -1) {
        const events = [];
        const prefix = `${callerAlias}:`;
        for (const [key, ingestor] of this.ingestors) {
            if (key.startsWith(prefix)) {
                events.push(...ingestor.getEvents(afterId));
            }
        }
        // Sort by receivedAt (ISO strings sort lexicographically)
        events.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
        return events;
    }
    /**
     * Get status of all ingestors for a caller.
     */
    getStatuses(callerAlias) {
        const statuses = [];
        const prefix = `${callerAlias}:`;
        for (const [key, ingestor] of this.ingestors) {
            if (key.startsWith(prefix)) {
                statuses.push(ingestor.getStatus());
            }
        }
        return statuses;
    }
    /**
     * Factory: create the appropriate ingestor instance based on config.
     */
    createIngestor(connectionAlias, config, secrets) {
        switch (config.type) {
            case 'websocket': {
                if (!config.websocket) {
                    console.error(`[ingestor] Missing websocket config for ${connectionAlias}`);
                    return null;
                }
                if (config.websocket.protocol === 'discord') {
                    return new DiscordGatewayIngestor(connectionAlias, secrets, config.websocket);
                }
                console.error(`[ingestor] Unsupported websocket protocol "${config.websocket.protocol}" for ${connectionAlias}`);
                return null;
            }
            case 'webhook':
                console.error(`[ingestor] Webhook ingestors not yet implemented (${connectionAlias})`);
                return null;
            case 'poll':
                console.error(`[ingestor] Poll ingestors not yet implemented (${connectionAlias})`);
                return null;
            default:
                console.error(`[ingestor] Unknown ingestor type for ${connectionAlias}`);
                return null;
        }
    }
}
//# sourceMappingURL=manager.js.map