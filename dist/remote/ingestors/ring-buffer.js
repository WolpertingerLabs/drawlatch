/**
 * Generic bounded ring buffer for event storage.
 *
 * When the buffer is full, the oldest item is evicted to make room.
 * Each pushed item receives a monotonically increasing ID that persists
 * across evictions and clears — enabling cursor-based polling.
 */
export class RingBuffer {
    capacity;
    buffer;
    head = 0; // next write position
    count = 0; // number of items currently stored
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
    }
    /**
     * Push an item into the buffer.
     * If the buffer is full, the oldest item is evicted.
     */
    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
    }
    /**
     * Return all buffered items in chronological order (oldest first).
     */
    toArray() {
        if (this.count === 0)
            return [];
        const start = (this.head - this.count + this.capacity) % this.capacity;
        const result = [];
        for (let i = 0; i < this.count; i++) {
            result.push(this.buffer[(start + i) % this.capacity]);
        }
        return result;
    }
    /**
     * Return items where the `id` field is greater than `afterId`.
     * Assumes items have a numeric `id` field (enforced at the call site).
     */
    since(afterId) {
        return this.toArray().filter((item) => {
            const id = item.id;
            return typeof id === 'number' && id > afterId;
        });
    }
    /** Current number of items in the buffer. */
    get size() {
        return this.count;
    }
    /** Remove all items. Does NOT reset any external ID counters. */
    clear() {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.count = 0;
    }
}
//# sourceMappingURL=ring-buffer.js.map