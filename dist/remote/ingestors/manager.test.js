/**
 * Unit tests for the IngestorManager.
 */
import { describe, it, expect } from 'vitest';
import { IngestorManager } from './manager.js';
describe('IngestorManager', () => {
    it('should return empty events for a caller with no ingestors', () => {
        const config = {
            host: '127.0.0.1',
            port: 9999,
            localKeysDir: '',
            callers: {
                'test-caller': { peerKeyDir: '', connections: [] },
            },
            rateLimitPerMinute: 60,
        };
        const manager = new IngestorManager(config);
        expect(manager.getAllEvents('test-caller')).toEqual([]);
        expect(manager.getStatuses('test-caller')).toEqual([]);
    });
    it('should return empty events for an unknown caller', () => {
        const config = {
            host: '127.0.0.1',
            port: 9999,
            localKeysDir: '',
            callers: {},
            rateLimitPerMinute: 60,
        };
        const manager = new IngestorManager(config);
        expect(manager.getAllEvents('nonexistent')).toEqual([]);
        expect(manager.getEvents('nonexistent', 'discord-bot')).toEqual([]);
        expect(manager.getStatuses('nonexistent')).toEqual([]);
    });
    it('should return empty events for a caller with connections but no ingestors', () => {
        const config = {
            host: '127.0.0.1',
            port: 9999,
            localKeysDir: '',
            connectors: [
                {
                    alias: 'no-ingestor-route',
                    secrets: { TOKEN: 'value' },
                    allowedEndpoints: ['https://example.com/**'],
                },
            ],
            callers: {
                'test-caller': { peerKeyDir: '', connections: ['no-ingestor-route'] },
            },
            rateLimitPerMinute: 60,
        };
        const manager = new IngestorManager(config);
        expect(manager.getAllEvents('test-caller')).toEqual([]);
        expect(manager.getStatuses('test-caller')).toEqual([]);
    });
    it('should start and stop without errors when no ingestors are configured', async () => {
        const config = {
            host: '127.0.0.1',
            port: 9999,
            localKeysDir: '',
            callers: {},
            rateLimitPerMinute: 60,
        };
        const manager = new IngestorManager(config);
        await expect(manager.startAll()).resolves.toBeUndefined();
        await expect(manager.stopAll()).resolves.toBeUndefined();
    });
});
//# sourceMappingURL=manager.test.js.map