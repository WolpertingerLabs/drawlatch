import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { loadConnection, listAvailableConnections } from './connections.js';

// Helper: readdirSync returns string[] when called with encoding, but
// vi.spyOn infers the Dirent[] overload. Cast through unknown to satisfy tsc.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
const mockReaddirSync = (files: string[]) => files as any;

describe('loadConnection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load a valid connection template', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'Test API',
        description: 'A test connection',
        allowedEndpoints: ['https://api.test.com/**'],
        headers: { Authorization: 'Bearer ${TEST_TOKEN}' },
        secrets: { TEST_TOKEN: '${TEST_TOKEN}' },
      }),
    );

    const route = loadConnection('test-api');

    expect(route.name).toBe('Test API');
    expect(route.allowedEndpoints).toEqual(['https://api.test.com/**']);
    expect(route.secrets).toEqual({ TEST_TOKEN: '${TEST_TOKEN}' });
    expect(route.headers).toEqual({ Authorization: 'Bearer ${TEST_TOKEN}' });
  });

  it('should throw for unknown connection name', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync([]));

    expect(() => loadConnection('nonexistent')).toThrow('Unknown connection "nonexistent"');
  });

  it('should include available connections in error message', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      // The connection file doesn't exist, but the directory does
      return !String(p).endsWith('.json');
    });
    vi.spyOn(fs, 'readdirSync').mockReturnValue(
      mockReaddirSync(['github.json', 'stripe.json']),
    );

    expect(() => loadConnection('nonexistent')).toThrow(
      'Available connections: github, stripe',
    );
  });

  it('should show (none) when no connections are available', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync([]));

    expect(() => loadConnection('nonexistent')).toThrow('Available connections: (none)');
  });
});

describe('listAvailableConnections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should list available connections alphabetically', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(
      mockReaddirSync(['trello.json', 'github.json', 'stripe.json']),
    );

    const available = listAvailableConnections();
    expect(available).toEqual(['github', 'stripe', 'trello']);
  });

  it('should return empty array when connections directory does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const available = listAvailableConnections();
    expect(available).toEqual([]);
  });

  it('should filter out non-JSON files', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(
      mockReaddirSync(['github.json', 'README.md', '.DS_Store']),
    );

    const available = listAvailableConnections();
    expect(available).toEqual(['github']);
  });
});

describe('bundled connection templates', () => {
  it('should load github connection template', () => {
    const route = loadConnection('github');

    expect(route.name).toBe('GitHub API');
    expect(route.allowedEndpoints).toEqual(['https://api.github.com/**']);
    expect(route.secrets).toHaveProperty('GITHUB_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load stripe connection template', () => {
    const route = loadConnection('stripe');

    expect(route.name).toBe('Stripe API');
    expect(route.allowedEndpoints).toEqual(['https://api.stripe.com/**']);
    expect(route.secrets).toHaveProperty('STRIPE_SECRET_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load trello connection template', () => {
    const route = loadConnection('trello');

    expect(route.name).toBe('Trello API');
    expect(route.allowedEndpoints).toEqual(['https://api.trello.com/**']);
    expect(route.secrets).toHaveProperty('TRELLO_API_KEY');
    expect(route.secrets).toHaveProperty('TRELLO_TOKEN');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load hex connection template', () => {
    const route = loadConnection('hex');

    expect(route.name).toBe('Hex API');
    expect(route.allowedEndpoints).toEqual(['https://app.hex.tech/api/**']);
    expect(route.secrets).toHaveProperty('HEX_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load devin connection template', () => {
    const route = loadConnection('devin');

    expect(route.name).toBe('Devin API');
    expect(route.allowedEndpoints).toEqual(['https://api.devin.ai/**']);
    expect(route.secrets).toHaveProperty('DEVIN_API_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load slack connection template', () => {
    const route = loadConnection('slack');

    expect(route.name).toBe('Slack API');
    expect(route.allowedEndpoints).toEqual(['https://slack.com/api/**']);
    expect(route.secrets).toHaveProperty('SLACK_BOT_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load linear connection template', () => {
    const route = loadConnection('linear');

    expect(route.name).toBe('Linear API');
    expect(route.allowedEndpoints).toEqual(['https://api.linear.app/**']);
    expect(route.secrets).toHaveProperty('LINEAR_API_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should list all bundled connections', () => {
    const available = listAvailableConnections();

    expect(available).toContain('github');
    expect(available).toContain('stripe');
    expect(available).toContain('trello');
    expect(available).toContain('hex');
    expect(available).toContain('devin');
    expect(available).toContain('slack');
    expect(available).toContain('linear');
  });
});
