import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  resolveSecrets,
  resolvePlaceholders,
  resolveRoutes,
  loadProxyConfig,
  loadRemoteConfig,
  saveProxyConfig,
  saveRemoteConfig,
  CONFIG_DIR,
  CONFIG_PATH,
  PROXY_CONFIG_PATH,
  REMOTE_CONFIG_PATH,
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

describe('config exports', () => {
  it('should export expected path constants', () => {
    expect(CONFIG_DIR).toContain('.mcp-secure-proxy');
    expect(CONFIG_PATH).toContain('config.json');
  });

  it('should export split config path constants', () => {
    expect(PROXY_CONFIG_PATH).toContain('proxy.config.json');
    expect(REMOTE_CONFIG_PATH).toContain('remote.config.json');
  });
});

describe('loadProxyConfig', () => {
  it('should return defaults when no config files exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadProxyConfig();

    expect(config.remoteUrl).toBe('http://localhost:9999');
    expect(config.connectTimeout).toBe(10_000);
    expect(config.requestTimeout).toBe(30_000);

    existsSpy.mockRestore();
  });

  it('should read from proxy.config.json when it exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === PROXY_CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        remoteUrl: 'https://custom-proxy.example.com:8443',
        connectTimeout: 5000,
      }),
    );

    const config = loadProxyConfig();

    expect(config.remoteUrl).toBe('https://custom-proxy.example.com:8443');
    expect(config.connectTimeout).toBe(5000);
    // Default values still present
    expect(config.requestTimeout).toBe(30_000);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should fall back to config.json when proxy.config.json does not exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // proxy.config.json does not exist, but config.json does
      return String(p) === CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        proxy: { remoteUrl: 'https://legacy.example.com:9999' },
        remote: { port: 7777 },
      }),
    );

    const config = loadProxyConfig();

    expect(config.remoteUrl).toBe('https://legacy.example.com:9999');
    // Defaults for unspecified fields
    expect(config.connectTimeout).toBe(10_000);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('loadRemoteConfig', () => {
  it('should return defaults when no config files exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadRemoteConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(9999);
    expect(config.routes).toEqual([]);
    expect(config.rateLimitPerMinute).toBe(60);

    existsSpy.mockRestore();
  });

  it('should read from remote.config.json when it exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === REMOTE_CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        host: '0.0.0.0',
        port: 8080,
        routes: [
          {
            secrets: { KEY: 'value' },
            allowedEndpoints: ['https://api.example.com/**'],
          },
        ],
      }),
    );

    const config = loadRemoteConfig();

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.routes).toHaveLength(1);
    // Default values still present
    expect(config.rateLimitPerMinute).toBe(60);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should fall back to config.json when remote.config.json does not exist', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // remote.config.json does not exist, but config.json does
      return String(p) === CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        proxy: { remoteUrl: 'https://legacy.example.com:9999' },
        remote: { port: 7777, rateLimitPerMinute: 120 },
      }),
    );

    const config = loadRemoteConfig();

    expect(config.port).toBe(7777);
    expect(config.rateLimitPerMinute).toBe(120);
    // Defaults for unspecified fields
    expect(config.host).toBe('127.0.0.1');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('loadRemoteConfig with connections', () => {
  it('should append connection routes after manual routes', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const filePath = String(p);
      // remote.config.json exists, connection template exists
      return filePath === REMOTE_CONFIG_PATH || filePath.endsWith('test-conn.json');
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const filePath = String(p);
      if (filePath === REMOTE_CONFIG_PATH) {
        return JSON.stringify({
          connections: ['test-conn'],
          routes: [
            {
              name: 'Manual Route',
              allowedEndpoints: ['https://api.manual.com/**'],
            },
          ],
        });
      }
      if (filePath.endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Test Connection',
          allowedEndpoints: ['https://api.test.com/**'],
          headers: { Authorization: 'Bearer ${TOKEN}' },
          secrets: { TOKEN: '${TEST_TOKEN}' },
        });
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });

    const config = loadRemoteConfig();

    expect(config.routes).toHaveLength(2);
    expect(config.routes[0].name).toBe('Manual Route');
    expect(config.routes[1].name).toBe('Test Connection');
    expect(config.connections).toEqual(['test-conn']);

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should work with connections and no manual routes', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const filePath = String(p);
      return filePath === REMOTE_CONFIG_PATH || filePath.endsWith('test-conn.json');
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const filePath = String(p);
      if (filePath === REMOTE_CONFIG_PATH) {
        return JSON.stringify({
          connections: ['test-conn'],
        });
      }
      if (filePath.endsWith('test-conn.json')) {
        return JSON.stringify({
          name: 'Test Connection',
          allowedEndpoints: ['https://api.test.com/**'],
        });
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });

    const config = loadRemoteConfig();

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].name).toBe('Test Connection');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should not modify routes when no connections field is present', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === REMOTE_CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        routes: [
          {
            name: 'Only Route',
            allowedEndpoints: ['https://api.example.com/**'],
          },
        ],
      }),
    );

    const config = loadRemoteConfig();

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].name).toBe('Only Route');
    expect(config.connections).toBeUndefined();

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should not modify routes when connections is an empty array', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      return String(p) === REMOTE_CONFIG_PATH;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        connections: [],
        routes: [
          {
            name: 'Only Route',
            allowedEndpoints: ['https://api.example.com/**'],
          },
        ],
      }),
    );

    const config = loadRemoteConfig();

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].name).toBe('Only Route');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('should load multiple connections in order', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const filePath = String(p);
      return (
        filePath === REMOTE_CONFIG_PATH ||
        filePath.endsWith('conn-a.json') ||
        filePath.endsWith('conn-b.json')
      );
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const filePath = String(p);
      if (filePath === REMOTE_CONFIG_PATH) {
        return JSON.stringify({
          connections: ['conn-a', 'conn-b'],
          routes: [],
        });
      }
      if (filePath.endsWith('conn-a.json')) {
        return JSON.stringify({
          name: 'Connection A',
          allowedEndpoints: ['https://api.a.com/**'],
        });
      }
      if (filePath.endsWith('conn-b.json')) {
        return JSON.stringify({
          name: 'Connection B',
          allowedEndpoints: ['https://api.b.com/**'],
        });
      }
      throw new Error(`Unexpected read: ${filePath}`);
    });

    const config = loadRemoteConfig();

    expect(config.routes).toHaveLength(2);
    expect(config.routes[0].name).toBe('Connection A');
    expect(config.routes[1].name).toBe('Connection B');

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('saveProxyConfig', () => {
  it('should create config directory and write proxy config file', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    saveProxyConfig({
      remoteUrl: 'http://localhost:9999',
      localKeysDir: '/path/to/keys',
      remotePublicKeysDir: '/path/to/remote-pub',
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    });

    expect(mkdirSpy).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true, mode: 0o700 });
    expect(writeSpy).toHaveBeenCalledWith(PROXY_CONFIG_PATH, expect.any(String), { mode: 0o600 });

    // Verify written content is valid JSON with flat structure (no .proxy wrapper)
    const writtenContent = writeSpy.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.remoteUrl).toBe('http://localhost:9999');
    expect(parsed.proxy).toBeUndefined(); // Should be flat, not nested

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });
});

describe('saveRemoteConfig', () => {
  it('should create config directory and write remote config file', () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    saveRemoteConfig({
      host: '127.0.0.1',
      port: 9999,
      localKeysDir: '/path/to/keys',
      authorizedPeersDir: '/path/to/peers',
      routes: [],
      rateLimitPerMinute: 60,
    });

    expect(mkdirSpy).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true, mode: 0o700 });
    expect(writeSpy).toHaveBeenCalledWith(REMOTE_CONFIG_PATH, expect.any(String), { mode: 0o600 });

    // Verify written content is valid JSON with flat structure (no .remote wrapper)
    const writtenContent = writeSpy.mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(9999);
    expect(parsed.remote).toBeUndefined(); // Should be flat, not nested

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });
});
