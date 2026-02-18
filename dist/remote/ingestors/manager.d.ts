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
import { type RemoteServerConfig } from '../../shared/config.js';
import type { IngestedEvent, IngestorStatus } from './types.js';
export declare class IngestorManager {
    private readonly config;
    /** Active ingestor instances, keyed by `callerAlias:connectionAlias`. */
    private ingestors;
    constructor(config: RemoteServerConfig);
    /**
     * Start ingestors for all callers whose connections have an `ingestor` config.
     * Called once when the remote server starts listening.
     */
    startAll(): Promise<void>;
    /**
     * Stop all running ingestors. Called during graceful shutdown.
     */
    stopAll(): Promise<void>;
    /**
     * Get events for a specific caller and connection.
     * @param callerAlias  The caller whose events to retrieve.
     * @param connectionAlias  The connection to filter by.
     * @param afterId  Return events with id > afterId. Pass -1 for all.
     */
    getEvents(callerAlias: string, connectionAlias: string, afterId?: number): IngestedEvent[];
    /**
     * Get events across all ingestors for a caller, sorted chronologically.
     * @param callerAlias  The caller whose events to retrieve.
     * @param afterId  Return events with id > afterId. Pass -1 for all.
     */
    getAllEvents(callerAlias: string, afterId?: number): IngestedEvent[];
    /**
     * Get status of all ingestors for a caller.
     */
    getStatuses(callerAlias: string): IngestorStatus[];
    /**
     * Factory: create the appropriate ingestor instance based on config.
     */
    private createIngestor;
}
//# sourceMappingURL=manager.d.ts.map