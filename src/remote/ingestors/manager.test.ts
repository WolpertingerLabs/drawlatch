/**
 * Unit tests for the IngestorManager.
 */

import { describe, it, expect } from 'vitest';
import { IngestorManager } from './manager.js';
import type { RemoteServerConfig } from '../../shared/config.js';
import type { IngestorConfig } from './types.js';
import type { IngestorOverrides } from '../../shared/config.js';

describe('IngestorManager', () => {
  it('should return empty events for a caller with no ingestors', () => {
    const config: RemoteServerConfig = {
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
    const config: RemoteServerConfig = {
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
    const config: RemoteServerConfig = {
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
    const config: RemoteServerConfig = {
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

describe('IngestorManager.mergeIngestorConfig', () => {
  const baseConfig: IngestorConfig = {
    type: 'websocket',
    websocket: {
      gatewayUrl: 'wss://gateway.discord.gg/?v=10&encoding=json',
      protocol: 'discord',
      intents: 3276799,
    },
  };

  it('should return template config unchanged when no overrides provided', () => {
    const result = IngestorManager.mergeIngestorConfig(baseConfig, undefined);
    expect(result).toEqual(baseConfig);
  });

  it('should return template config unchanged when overrides is empty object', () => {
    const result = IngestorManager.mergeIngestorConfig(baseConfig, {});
    expect(result.websocket?.intents).toBe(3276799);
    expect(result.websocket?.eventFilter).toBeUndefined();
    expect(result.websocket?.guildIds).toBeUndefined();
    expect(result.websocket?.channelIds).toBeUndefined();
    expect(result.websocket?.userIds).toBeUndefined();
  });

  it('should override intents', () => {
    const overrides: IngestorOverrides = { intents: 4609 };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.intents).toBe(4609);
  });

  it('should override eventFilter', () => {
    const overrides: IngestorOverrides = { eventFilter: ['MESSAGE_CREATE'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.eventFilter).toEqual(['MESSAGE_CREATE']);
  });

  it('should override guildIds', () => {
    const overrides: IngestorOverrides = { guildIds: ['123', '456'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.guildIds).toEqual(['123', '456']);
  });

  it('should override channelIds', () => {
    const overrides: IngestorOverrides = { channelIds: ['789'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.channelIds).toEqual(['789']);
  });

  it('should override userIds', () => {
    const overrides: IngestorOverrides = { userIds: ['user1', 'user2'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.userIds).toEqual(['user1', 'user2']);
  });

  it('should override multiple fields at once', () => {
    const overrides: IngestorOverrides = {
      intents: 512,
      eventFilter: ['MESSAGE_CREATE', 'MESSAGE_UPDATE'],
      guildIds: ['111'],
      channelIds: ['222'],
      userIds: ['333'],
    };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.websocket?.intents).toBe(512);
    expect(result.websocket?.eventFilter).toEqual(['MESSAGE_CREATE', 'MESSAGE_UPDATE']);
    expect(result.websocket?.guildIds).toEqual(['111']);
    expect(result.websocket?.channelIds).toEqual(['222']);
    expect(result.websocket?.userIds).toEqual(['333']);
  });

  it('should not mutate the original template config', () => {
    const overrides: IngestorOverrides = { intents: 1, guildIds: ['999'] };
    IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    // Original should be unchanged
    expect(baseConfig.websocket?.intents).toBe(3276799);
    expect(baseConfig.websocket?.guildIds).toBeUndefined();
  });

  it('should preserve non-overridden template fields', () => {
    const overrides: IngestorOverrides = { guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(baseConfig, overrides);
    expect(result.type).toBe('websocket');
    expect(result.websocket?.gatewayUrl).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    expect(result.websocket?.protocol).toBe('discord');
    expect(result.websocket?.intents).toBe(3276799);
  });

  it('should handle config without websocket block gracefully', () => {
    const webhookConfig: IngestorConfig = {
      type: 'webhook',
      webhook: { path: 'github' },
    };
    const overrides: IngestorOverrides = { intents: 4609, guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(webhookConfig, overrides);
    // Should not crash; websocket overrides are ignored for non-websocket types
    expect(result.type).toBe('webhook');
    expect(result.webhook?.path).toBe('github');
    expect(result.websocket).toBeUndefined();
  });
});

describe('IngestorManager.has', () => {
  it('should return false when no ingestor exists', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {
        'test-caller': { peerKeyDir: '', connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    expect(manager.has('test-caller', 'discord-bot')).toBe(false);
  });

  it('should return false for unknown caller', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    expect(manager.has('nonexistent', 'discord-bot')).toBe(false);
  });
});

describe('IngestorManager.stopOne', () => {
  it('should return error when no ingestor is running', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {
        'test-caller': { peerKeyDir: '', connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.stopOne('test-caller', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('No ingestor running');
  });
});

describe('IngestorManager.startOne', () => {
  it('should return error for unknown caller', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('nonexistent', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('Unknown caller');
  });

  it('should return error when caller does not have the connection', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['other-connection'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
    expect(result.error).toContain('Caller does not have connection');
  });

  it('should return error when connection has no ingestor config', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      connectors: [
        {
          alias: 'no-ingestor',
          secrets: { TOKEN: 'value' },
          allowedEndpoints: ['https://example.com/**'],
        },
      ],
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['no-ingestor'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'no-ingestor');
    expect(result.success).toBe(false);
    expect(result.connection).toBe('no-ingestor');
    expect(result.error).toContain('does not have an ingestor');
  });
});

describe('IngestorManager.restartOne', () => {
  it('should call startOne when no ingestor exists (returns error for missing config)', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {
        'test-caller': { peerKeyDir: '', connections: [] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.restartOne('test-caller', 'discord-bot');
    // restartOne delegates to startOne, which fails because the caller doesn't have this connection
    expect(result.success).toBe(false);
    expect(result.connection).toBe('discord-bot');
  });

  it('should return error for unknown caller', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      callers: {},
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.restartOne('unknown', 'discord-bot');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown caller');
  });
});

describe('IngestorManager — webhook ingestor lifecycle', () => {
  it('should successfully start a webhook ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    const result = await manager.startOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.connection).toBe('github');
    expect(result.state).toBe('connected');
    expect(manager.has('test-caller', 'github')).toBe(true);

    // Stop it
    const stopResult = await manager.stopOne('test-caller', 'github');
    expect(stopResult.success).toBe(true);
    expect(stopResult.state).toBe('stopped');
    expect(manager.has('test-caller', 'github')).toBe(false);
  });

  it('should return already-running status when starting a running ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    // Start again — should return success with current state
    const result = await manager.startOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.state).toBe('connected');

    await manager.stopOne('test-caller', 'github');
  });

  it('should restart a webhook ingestor', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    const result = await manager.restartOne('test-caller', 'github');
    expect(result.success).toBe(true);
    expect(result.connection).toBe('github');
    expect(manager.has('test-caller', 'github')).toBe(true);

    await manager.stopOne('test-caller', 'github');
  });

  it('should handle getWebhookIngestors for started webhook ingestors', async () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '',
      connectors: [
        {
          alias: 'github',
          secrets: { GITHUB_TOKEN: 'ghp_test', GITHUB_WEBHOOK_SECRET: 'secret123' },
          allowedEndpoints: ['https://api.github.com/**'],
          ingestor: {
            type: 'webhook',
            webhook: {
              path: 'github',
              signatureHeader: 'X-Hub-Signature-256',
              signatureSecret: 'GITHUB_WEBHOOK_SECRET',
            },
          },
        },
      ],
      callers: {
        'test-caller': { peerKeyDir: '', connections: ['github'] },
      },
      rateLimitPerMinute: 60,
    };
    const manager = new IngestorManager(config);
    await manager.startOne('test-caller', 'github');

    const webhookIngestors = manager.getWebhookIngestors('github');
    expect(webhookIngestors).toHaveLength(1);

    const nonexistent = manager.getWebhookIngestors('nonexistent');
    expect(nonexistent).toHaveLength(0);

    await manager.stopOne('test-caller', 'github');
  });
});

describe('IngestorManager.mergeIngestorConfig — poll overrides', () => {
  const pollConfig: IngestorConfig = {
    type: 'poll',
    poll: {
      url: 'https://api.example.com/items',
      intervalMs: 60_000,
      method: 'POST',
      body: { query: 'test' },
      deduplicateBy: 'id',
      responsePath: 'results',
      eventType: 'item_updated',
    },
  };

  it('should override intervalMs for poll config', () => {
    const overrides: IngestorOverrides = { intervalMs: 30_000 };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(result.poll?.intervalMs).toBe(30_000);
  });

  it('should not mutate original poll config', () => {
    const overrides: IngestorOverrides = { intervalMs: 15_000 };
    IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(pollConfig.poll?.intervalMs).toBe(60_000);
  });

  it('should preserve non-overridden poll fields', () => {
    const overrides: IngestorOverrides = { intervalMs: 30_000 };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    expect(result.type).toBe('poll');
    expect(result.poll?.url).toBe('https://api.example.com/items');
    expect(result.poll?.method).toBe('POST');
    expect(result.poll?.deduplicateBy).toBe('id');
    expect(result.poll?.responsePath).toBe('results');
    expect(result.poll?.eventType).toBe('item_updated');
  });

  it('should handle poll config without overrides', () => {
    const result = IngestorManager.mergeIngestorConfig(pollConfig, undefined);
    expect(result).toEqual(pollConfig);
  });

  it('should handle poll config with empty overrides', () => {
    const result = IngestorManager.mergeIngestorConfig(pollConfig, {});
    expect(result.poll?.intervalMs).toBe(60_000);
  });

  it('should not apply websocket overrides to poll config', () => {
    const overrides: IngestorOverrides = { intents: 4609, guildIds: ['123'] };
    const result = IngestorManager.mergeIngestorConfig(pollConfig, overrides);
    // Should not crash; websocket overrides are ignored for poll types
    expect(result.type).toBe('poll');
    expect(result.poll?.intervalMs).toBe(60_000);
    expect(result.websocket).toBeUndefined();
  });
});
