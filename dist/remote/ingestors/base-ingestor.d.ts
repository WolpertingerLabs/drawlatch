/**
 * Abstract base class for all ingestor types.
 *
 * Provides common functionality: ring buffer management, event counting,
 * status reporting, and a standard interface for start/stop lifecycle.
 *
 * Subclasses implement `start()` and `stop()` for their specific protocol
 * (WebSocket, webhook listener, HTTP poller, etc.) and call `pushEvent()`
 * whenever they receive data from the external service.
 */
import { EventEmitter } from 'node:events';
import type { IngestedEvent, IngestorState, IngestorStatus } from './types.js';
import { RingBuffer } from './ring-buffer.js';
export declare abstract class BaseIngestor extends EventEmitter {
    /** The connection alias (e.g., 'discord-bot'). */
    protected readonly connectionAlias: string;
    /** The ingestor type (for status reporting). */
    protected readonly ingestorType: 'websocket' | 'webhook' | 'poll';
    /** Resolved secrets for the parent connection. */
    protected readonly secrets: Record<string, string>;
    protected state: IngestorState;
    protected buffer: RingBuffer<IngestedEvent>;
    protected totalEventsReceived: number;
    protected lastEventAt: string | null;
    protected errorMessage?: string;
    constructor(
    /** The connection alias (e.g., 'discord-bot'). */
    connectionAlias: string, 
    /** The ingestor type (for status reporting). */
    ingestorType: 'websocket' | 'webhook' | 'poll', 
    /** Resolved secrets for the parent connection. */
    secrets: Record<string, string>, 
    /** Buffer capacity (defaults to DEFAULT_BUFFER_SIZE). */
    bufferSize?: number);
    /** Start the ingestor (connect WebSocket, begin polling, etc.). */
    abstract start(): Promise<void>;
    /** Stop the ingestor cleanly (close connections, clear timers). */
    abstract stop(): Promise<void>;
    /**
     * Push a new event into the ring buffer.
     * Called by subclasses when they receive data from an external service.
     */
    protected pushEvent(eventType: string, data: unknown): void;
    /**
     * Retrieve events since a cursor.
     * @param afterId  Return events with id > afterId. Pass -1 (or omit) for all buffered events.
     */
    getEvents(afterId?: number): IngestedEvent[];
    /** Return the current status of this ingestor. */
    getStatus(): IngestorStatus;
}
//# sourceMappingURL=base-ingestor.d.ts.map