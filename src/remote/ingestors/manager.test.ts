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
