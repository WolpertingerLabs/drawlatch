import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { resolveSecrets, loadConfig, saveConfig, CONFIG_DIR, CONFIG_PATH } from './config.js';

describe('resolveSecrets', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should pass through literal string values', () => {
    const result = resolveSecrets({
      apiKey: 'sk-1234567890',
      token: 'my-literal-token',
    });

    expect(result).toEqual({
      apiKey: 'sk-1234567890',
      token: 'my-literal-token',
    });
  });

  it('should resolve ${VAR_NAME} from environment', () => {
    process.env.MY_SECRET = 'resolved-value';
    process.env.ANOTHER_SECRET = 'another-value';

    const result = resolveSecrets({
      secret1: '${MY_SECRET}',
      secret2: '${ANOTHER_SECRET}',
    });

    expect(result).toEqual({
      secret1: 'resolved-value',
      secret2: 'another-value',
    });
  });

  it('should omit secrets where env var is not found', () => {
    delete process.env.NONEXISTENT_VAR;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      /* noop */
    });

    const result = resolveSecrets({
      missing: '${NONEXISTENT_VAR}',
      present: 'literal',
    });

    expect(result).toEqual({ present: 'literal' });
    expect(result).not.toHaveProperty('missing');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NONEXISTENT_VAR'));

    consoleSpy.mockRestore();
  });

  it('should handle mixed literal and env var values', () => {
    process.env.DB_PASSWORD = 'p@ssw0rd';

    const result = resolveSecrets({
      host: 'localhost',
      password: '${DB_PASSWORD}',
      port: '5432',
    });

    expect(result).toEqual({
      host: 'localhost',
      password: 'p@ssw0rd',
      port: '5432',
    });
  });

  it('should handle empty secrets map', () => {
    const result = resolveSecrets({});
    expect(result).toEqual({});
  });

  it('should not treat partial ${} patterns as env vars', () => {
    const result = resolveSecrets({
      partialStart: '${INCOMPLETE',
      partialEnd: 'INCOMPLETE}',
      noDelim: 'JUST_A_STRING',
      withPrefix: 'prefix_${SOME_VAR}',
    });

    expect(result).toEqual({
      partialStart: '${INCOMPLETE',
      partialEnd: 'INCOMPLETE}',
      noDelim: 'JUST_A_STRING',
      withPrefix: 'prefix_${SOME_VAR}',
    });
  });

  it('should resolve env var with empty string value', () => {
    process.env.EMPTY_VAR = '';

    const result = resolveSecrets({
      empty: '${EMPTY_VAR}',
    });

    expect(result).toEqual({ empty: '' });
  });

  it('should resolve env var with special characters', () => {
    process.env.SPECIAL_CHARS = 'p@$$w0rd!#%^&*()';

    const result = resolveSecrets({
      special: '${SPECIAL_CHARS}',
    });

    expect(result).toEqual({ special: 'p@$$w0rd!#%^&*()' });
  });
});

describe('loadConfig', () => {
  it('should return defaults when config file does not exist', () => {
    // loadConfig reads CONFIG_PATH which is ~/.mcp-secure-proxy/config.json
    // Mock fs.existsSync to return false for CONFIG_PATH
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.proxy.remoteUrl).toBe('http://localhost:9999');
    expect(config.proxy.connectTimeout).toBe(10_000);
    expect(config.proxy.requestTimeout).toBe(30_000);
    expect(config.remote.host).toBe('127.0.0.1');
    expect(config.remote.port).toBe(9999);
    expect(config.remote.secrets).toEqual({});
    expect(config.remote.allowedEndpoints).toEqual([]);
    expect(config.remote.rateLimitPerMinute).toBe(60);

    existsSpy.mockRestore();
  });

  it('should merge file config with defaults', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        proxy: { remoteUrl: 'https://custom.example.com:8443' },
        remote: { port: 7777, secrets: { KEY: 'value' } },
      }),
    );

    const config = loadConfig();

    // Overridden values
    expect(config.proxy.remoteUrl).toBe('https://custom.example.com:8443');
    expect(config.remote.port).toBe(7777);
    expect(config.remote.secrets).toEqual({ KEY: 'value' });

    // Default values still present
    expect(config.proxy.connectTimeout).toBe(10_000);
    expect(config.remote.host).toBe('127.0.0.1');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should handle partial config (only proxy section)', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        proxy: { connectTimeout: 5000 },
      }),
    );

    const config = loadConfig();

    expect(config.proxy.connectTimeout).toBe(5000);
    expect(config.proxy.remoteUrl).toBe('http://localhost:9999');
    // remote section should be all defaults
    expect(config.remote.port).toBe(9999);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('saveConfig', () => {
  it('should create config directory and write file', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const config = loadConfig();

    // Mock existsSync for the loadConfig call above (returns defaults)
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    saveConfig(config);

    expect(mkdirSpy).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true, mode: 0o700 });
    expect(writeSpy).toHaveBeenCalledWith(CONFIG_PATH, expect.any(String), { mode: 0o600 });

    // Verify the written content is valid JSON
    const writtenContent = writeSpy.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.proxy).toBeDefined();
    expect(parsed.remote).toBeDefined();

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    existsSpy.mockRestore();
  });
});

describe('config exports', () => {
  it('should export expected path constants', () => {
    expect(CONFIG_DIR).toContain('.mcp-secure-proxy');
    expect(CONFIG_PATH).toContain('config.json');
  });
});
