/**
 * Generic bounded ring buffer for event storage.
 *
 * When the buffer is full, the oldest item is evicted to make room.
 * Each pushed item receives a monotonically increasing ID that persists
 * across evictions and clears — enabling cursor-based polling.
 */
export declare class RingBuffer<T> {
    private readonly capacity;
    private buffer;
    private head;
    private count;
    constructor(capacity: number);
    /**
     * Push an item into the buffer.
     * If the buffer is full, the oldest item is evicted.
     */
    push(item: T): void;
    /**
     * Return all buffered items in chronological order (oldest first).
     */
    toArray(): T[];
    /**
     * Return items where the `id` field is greater than `afterId`.
     * Assumes items have a numeric `id` field (enforced at the call site).
     */
    since(afterId: number): T[];
    /** Current number of items in the buffer. */
    get size(): number;
    /** Remove all items. Does NOT reset any external ID counters. */
    clear(): void;
}
//# sourceMappingURL=ring-buffer.d.ts.map