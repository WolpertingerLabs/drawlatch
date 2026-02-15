import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  resolveSecrets,
  resolvePlaceholders,
  resolveRoutes,
  loadConfig,
  saveConfig,
  CONFIG_DIR,
  CONFIG_PATH,
} from './config.js';

describe('resolvePlaceholders', () => {
  it('should replace ${VAR} with secret values', () => {
    const secrets = { API_KEY: 'sk-123', TOKEN: 'tok-456' };
    expect(resolvePlaceholders('Bearer ${TOKEN}', secrets)).toBe('Bearer tok-456');
    expect(resolvePlaceholders('${API_KEY}', secrets)).toBe('sk-123');
  });

  it('should replace multiple placeholders', () => {
    const secrets = { HOST: 'example.com', PORT: '8080' };
    expect(resolvePlaceholders('https://${HOST}:${PORT}/api', secrets)).toBe(
      'https://example.com:8080/api',
    );
  });

  it('should leave unknown placeholders unchanged and log a warning', () => {
    const secrets = { KNOWN: 'value' };
    expect(resolvePlaceholders('${UNKNOWN}', secrets)).toBe('${UNKNOWN}');
  });

  it('should return unchanged strings without placeholders', () => {
    const secrets = { KEY: 'value' };
    expect(resolvePlaceholders('no placeholders here', secrets)).toBe('no placeholders here');
  });

  it('should handle empty strings', () => {
    expect(resolvePlaceholders('', {})).toBe('');
  });

  it('should handle secrets with special characters', () => {
    const secrets = { PASS: 'p@$$w0rd!&' };
    expect(resolvePlaceholders('password=${PASS}', secrets)).toBe('password=p@$$w0rd!&');
  });
});

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

describe('resolveRoutes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should resolve secrets within each route independently', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY_A: 'value-a' },
        allowedEndpoints: ['https://api.a.com/**'],
      },
      {
        secrets: { KEY_B: 'value-b' },
        allowedEndpoints: ['https://api.b.com/**'],
      },
    ]);

    expect(routes).toHaveLength(2);
    expect(routes[0].secrets).toEqual({ KEY_A: 'value-a' });
    expect(routes[1].secrets).toEqual({ KEY_B: 'value-b' });
  });

  it('should resolve header placeholders against the route own secrets', () => {
    const routes = resolveRoutes([
      {
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        secrets: { API_TOKEN: 'my-secret-token' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].headers).toEqual({ Authorization: 'Bearer my-secret-token' });
  });

  it('should handle routes with no secrets', () => {
    const routes = resolveRoutes([
      {
        headers: { 'X-Custom': 'static-value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].secrets).toEqual({});
    expect(routes[0].headers).toEqual({ 'X-Custom': 'static-value' });
  });

  it('should handle routes with no headers', () => {
    const routes = resolveRoutes([
      {
        secrets: { KEY: 'value' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].headers).toEqual({});
    expect(routes[0].secrets).toEqual({ KEY: 'value' });
  });

  it('should handle empty routes array', () => {
    const routes = resolveRoutes([]);
    expect(routes).toEqual([]);
  });

  it('should resolve env var references in secrets within routes', () => {
    process.env.ROUTE_SECRET = 'env-resolved-value';

    const routes = resolveRoutes([
      {
        secrets: { TOKEN: '${ROUTE_SECRET}' },
        headers: { Authorization: 'Bearer ${TOKEN}' },
        allowedEndpoints: ['https://api.example.com/**'],
      },
    ]);

    expect(routes[0].secrets).toEqual({ TOKEN: 'env-resolved-value' });
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer env-resolved-value' });
  });

  it('should not leak secrets across routes when resolving headers', () => {
    const routes = resolveRoutes([
      {
        headers: { Authorization: 'Bearer ${TOKEN_A}' },
        secrets: { TOKEN_A: 'secret-a' },
        allowedEndpoints: ['https://api.a.com/**'],
      },
      {
        headers: { Authorization: 'Bearer ${TOKEN_A}' },
        secrets: { TOKEN_B: 'secret-b' },
        allowedEndpoints: ['https://api.b.com/**'],
      },
    ]);

    // Route A should resolve TOKEN_A
    expect(routes[0].headers).toEqual({ Authorization: 'Bearer secret-a' });
    // Route B should NOT resolve TOKEN_A (it only has TOKEN_B)
    expect(routes[1].headers).toEqual({ Authorization: 'Bearer ${TOKEN_A}' });
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
    expect(config.remote.routes).toEqual([]);
    expect(config.remote.rateLimitPerMinute).toBe(60);

    existsSpy.mockRestore();
  });

  it('should merge file config with defaults', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        proxy: { remoteUrl: 'https://custom.example.com:8443' },
        remote: {
          port: 7777,
          routes: [
            {
              secrets: { KEY: 'value' },
              allowedEndpoints: ['https://api.example.com/**'],
            },
          ],
        },
      }),
    );

    const config = loadConfig();

    // Overridden values
    expect(config.proxy.remoteUrl).toBe('https://custom.example.com:8443');
    expect(config.remote.port).toBe(7777);
    expect(config.remote.routes).toHaveLength(1);
    expect(config.remote.routes[0].secrets).toEqual({ KEY: 'value' });
    expect(config.remote.routes[0].allowedEndpoints).toEqual(['https://api.example.com/**']);

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
    expect(config.remote.routes).toEqual([]);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should load config with multiple routes', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        remote: {
          routes: [
            {
              headers: { Authorization: 'Bearer token-a' },
              secrets: { KEY_A: 'val-a' },
              allowedEndpoints: ['https://api.a.com/**'],
            },
            {
              headers: { Authorization: 'Bearer token-b' },
              allowedEndpoints: ['https://api.b.com/**'],
            },
          ],
        },
      }),
    );

    const config = loadConfig();

    expect(config.remote.routes).toHaveLength(2);
    expect(config.remote.routes[0].headers).toEqual({ Authorization: 'Bearer token-a' });
    expect(config.remote.routes[0].secrets).toEqual({ KEY_A: 'val-a' });
    expect(config.remote.routes[1].headers).toEqual({ Authorization: 'Bearer token-b' });
    expect(config.remote.routes[1].secrets).toBeUndefined();

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
    expect(parsed.remote.routes).toBeDefined();

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
