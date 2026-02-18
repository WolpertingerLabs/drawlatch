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
import { RingBuffer } from './ring-buffer.js';
import { DEFAULT_BUFFER_SIZE } from './types.js';
export class BaseIngestor extends EventEmitter {
    connectionAlias;
    ingestorType;
    secrets;
    state = 'stopped';
    buffer;
    totalEventsReceived = 0;
    lastEventAt = null;
    errorMessage;
    constructor(
    /** The connection alias (e.g., 'discord-bot'). */
    connectionAlias, 
    /** The ingestor type (for status reporting). */
    ingestorType, 
    /** Resolved secrets for the parent connection. */
    secrets, 
    /** Buffer capacity (defaults to DEFAULT_BUFFER_SIZE). */
    bufferSize = DEFAULT_BUFFER_SIZE) {
        super();
        this.connectionAlias = connectionAlias;
        this.ingestorType = ingestorType;
        this.secrets = secrets;
        this.buffer = new RingBuffer(bufferSize);
    }
    /**
     * Push a new event into the ring buffer.
     * Called by subclasses when they receive data from an external service.
     */
    pushEvent(eventType, data) {
        const event = {
            id: this.totalEventsReceived++,
            receivedAt: new Date().toISOString(),
            source: this.connectionAlias,
            eventType,
            data,
        };
        this.buffer.push(event);
        this.lastEventAt = event.receivedAt;
        this.emit('event', event);
    }
    /**
     * Retrieve events since a cursor.
     * @param afterId  Return events with id > afterId. Pass -1 (or omit) for all buffered events.
     */
    getEvents(afterId = -1) {
        if (afterId < 0)
            return this.buffer.toArray();
        return this.buffer.since(afterId);
    }
    /** Return the current status of this ingestor. */
    getStatus() {
        return {
            connection: this.connectionAlias,
            type: this.ingestorType,
            state: this.state,
            bufferedEvents: this.buffer.size,
            totalEventsReceived: this.totalEventsReceived,
            lastEventAt: this.lastEventAt,
            ...(this.errorMessage && { error: this.errorMessage }),
        };
    }
}
//# sourceMappingURL=base-ingestor.js.map