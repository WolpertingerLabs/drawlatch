import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  loadConnection,
  listAvailableConnections,
  listConnectionTemplates,
} from './connections.js';

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
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['github.json', 'stripe.json']));

    expect(() => loadConnection('nonexistent')).toThrow('Available connections: github, stripe');
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
  it('should load anthropic connection template', () => {
    const route = loadConnection('anthropic');

    expect(route.name).toBe('Anthropic API');
    expect(route.allowedEndpoints).toEqual(['https://api.anthropic.com/**']);
    expect(route.secrets).toHaveProperty('ANTHROPIC_API_KEY');
    expect(route.headers).toHaveProperty('x-api-key');
    expect(route.headers).toHaveProperty('anthropic-version');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load discord-bot connection template', () => {
    const route = loadConnection('discord-bot');

    expect(route.name).toBe('Discord Bot API');
    expect(route.allowedEndpoints).toEqual(['https://discord.com/api/v10/**']);
    expect(route.secrets).toHaveProperty('DISCORD_BOT_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.headers?.Authorization).toContain('Bot');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load discord-oauth connection template', () => {
    const route = loadConnection('discord-oauth');

    expect(route.name).toBe('Discord OAuth2 API');
    expect(route.allowedEndpoints).toEqual(['https://discord.com/api/v10/**']);
    expect(route.secrets).toHaveProperty('DISCORD_OAUTH_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.headers?.Authorization).toContain('Bearer');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load github connection template', () => {
    const route = loadConnection('github');

    expect(route.name).toBe('GitHub API');
    expect(route.allowedEndpoints).toEqual(['https://api.github.com/**']);
    expect(route.secrets).toHaveProperty('GITHUB_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load google connection template', () => {
    const route = loadConnection('google');

    expect(route.name).toBe('Google APIs');
    expect(route.allowedEndpoints).toContain('https://www.googleapis.com/**');
    expect(route.allowedEndpoints).toContain('https://sheets.googleapis.com/**');
    expect(route.allowedEndpoints).toContain('https://drive.googleapis.com/**');
    expect(route.secrets).toHaveProperty('GOOGLE_API_TOKEN');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load google-ai connection template', () => {
    const route = loadConnection('google-ai');

    expect(route.name).toBe('Google AI (Gemini) API');
    expect(route.allowedEndpoints).toEqual(['https://generativelanguage.googleapis.com/**']);
    expect(route.secrets).toHaveProperty('GOOGLE_AI_API_KEY');
    expect(route.headers).toHaveProperty('x-goog-api-key');
    expect(route.docsUrl).toBeTruthy();
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

  it('should load notion connection template', () => {
    const route = loadConnection('notion');

    expect(route.name).toBe('Notion API');
    expect(route.allowedEndpoints).toEqual(['https://api.notion.com/**']);
    expect(route.secrets).toHaveProperty('NOTION_API_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.headers).toHaveProperty('Notion-Version');
    expect(route.docsUrl).toBeTruthy();
  });

  it('should load openai connection template', () => {
    const route = loadConnection('openai');

    expect(route.name).toBe('OpenAI API');
    expect(route.allowedEndpoints).toEqual(['https://api.openai.com/**']);
    expect(route.secrets).toHaveProperty('OPENAI_API_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should load openrouter connection template', () => {
    const route = loadConnection('openrouter');

    expect(route.name).toBe('OpenRouter API');
    expect(route.allowedEndpoints).toEqual(['https://openrouter.ai/api/**']);
    expect(route.secrets).toHaveProperty('OPENROUTER_API_KEY');
    expect(route.headers).toHaveProperty('Authorization');
    expect(route.docsUrl).toBeTruthy();
    expect(route.openApiUrl).toBeTruthy();
  });

  it('should list all bundled connections', () => {
    const available = listAvailableConnections();

    expect(available).toContain('anthropic');
    expect(available).toContain('devin');
    expect(available).toContain('discord-bot');
    expect(available).toContain('discord-oauth');
    expect(available).toContain('github');
    expect(available).toContain('google');
    expect(available).toContain('google-ai');
    expect(available).toContain('hex');
    expect(available).toContain('linear');
    expect(available).toContain('notion');
    expect(available).toContain('openai');
    expect(available).toContain('openrouter');
    expect(available).toContain('slack');
    expect(available).toContain('stripe');
    expect(available).toContain('trello');
  });
});

// ── listConnectionTemplates ─────────────────────────────────────────────

describe('listConnectionTemplates (unit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return correct structure for a template with ingestor', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['myapi.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'My API',
        description: 'An API with a webhook ingestor',
        docsUrl: 'https://docs.myapi.com',
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        secrets: { API_TOKEN: '${API_TOKEN}', WEBHOOK_SECRET: '${WEBHOOK_SECRET}' },
        allowedEndpoints: ['https://api.myapi.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'myapi' } },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates).toHaveLength(1);

    const t = templates[0];
    expect(t.alias).toBe('myapi');
    expect(t.name).toBe('My API');
    expect(t.description).toBe('An API with a webhook ingestor');
    expect(t.docsUrl).toBe('https://docs.myapi.com');
    expect(t.requiredSecrets).toEqual(['API_TOKEN']);
    expect(t.optionalSecrets).toEqual(['WEBHOOK_SECRET']);
    expect(t.hasIngestor).toBe(true);
    expect(t.ingestorType).toBe('webhook');
    expect(t.allowedEndpoints).toEqual(['https://api.myapi.com/**']);
  });

  it('should return correct structure for a template without ingestor', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['simple.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'Simple API',
        headers: { 'x-api-key': '${KEY}' },
        secrets: { KEY: '${KEY}' },
        allowedEndpoints: ['https://api.simple.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates).toHaveLength(1);

    const t = templates[0];
    expect(t.alias).toBe('simple');
    expect(t.name).toBe('Simple API');
    expect(t.description).toBeUndefined();
    expect(t.openApiUrl).toBeUndefined();
    expect(t.requiredSecrets).toEqual(['KEY']);
    expect(t.optionalSecrets).toEqual([]);
    expect(t.hasIngestor).toBe(false);
    expect(t.ingestorType).toBeUndefined();
  });

  it('should correctly categorize required vs optional secrets', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['mixed.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'Mixed',
        headers: {
          Authorization: 'Bearer ${AUTH_TOKEN}',
          'X-Custom': '${CUSTOM_HEADER}',
        },
        secrets: {
          AUTH_TOKEN: '${AUTH_TOKEN}',
          CUSTOM_HEADER: '${CUSTOM_HEADER}',
          WEBHOOK_KEY: '${WEBHOOK_KEY}',
          POLL_URL_VAR: '${POLL_URL_VAR}',
        },
        allowedEndpoints: ['https://api.mixed.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    const t = templates[0];
    expect(t.requiredSecrets).toEqual(['AUTH_TOKEN', 'CUSTOM_HEADER']);
    expect(t.optionalSecrets).toEqual(['WEBHOOK_KEY', 'POLL_URL_VAR']);
  });

  it('should return empty array when no connections exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const templates = listConnectionTemplates();
    expect(templates).toEqual([]);
  });

  it('should fall back to alias when name is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['nameless.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        allowedEndpoints: ['https://api.nameless.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].name).toBe('nameless');
  });
});

describe('listConnectionTemplates (integration)', () => {
  it('should return entries for all bundled templates', () => {
    const templates = listConnectionTemplates();
    const available = listAvailableConnections();

    expect(templates).toHaveLength(available.length);

    const aliases = templates.map((t) => t.alias);
    for (const name of available) {
      expect(aliases).toContain(name);
    }
  });

  it('should have a non-empty name and at least one endpoint for every template', () => {
    const templates = listConnectionTemplates();

    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.allowedEndpoints.length).toBeGreaterThan(0);
    }
  });

  it('should correctly introspect github template', () => {
    const templates = listConnectionTemplates();
    const github = templates.find((t) => t.alias === 'github')!;

    expect(github.name).toBe('GitHub API');
    expect(github.requiredSecrets).toEqual(['GITHUB_TOKEN']);
    expect(github.optionalSecrets).toEqual(['GITHUB_WEBHOOK_SECRET']);
    expect(github.hasIngestor).toBe(true);
    expect(github.ingestorType).toBe('webhook');
    expect(github.docsUrl).toBeTruthy();
    expect(github.openApiUrl).toBeTruthy();
  });

  it('should correctly introspect anthropic template (no ingestor)', () => {
    const templates = listConnectionTemplates();
    const anthropic = templates.find((t) => t.alias === 'anthropic')!;

    expect(anthropic.name).toBe('Anthropic API');
    expect(anthropic.requiredSecrets).toEqual(['ANTHROPIC_API_KEY']);
    expect(anthropic.optionalSecrets).toEqual([]);
    expect(anthropic.hasIngestor).toBe(false);
    expect(anthropic.ingestorType).toBeUndefined();
  });

  it('should correctly introspect slack template (websocket ingestor)', () => {
    const templates = listConnectionTemplates();
    const slack = templates.find((t) => t.alias === 'slack')!;

    expect(slack.name).toBe('Slack API');
    expect(slack.requiredSecrets).toEqual(['SLACK_BOT_TOKEN']);
    expect(slack.optionalSecrets).toEqual(['SLACK_APP_TOKEN']);
    expect(slack.hasIngestor).toBe(true);
    expect(slack.ingestorType).toBe('websocket');
  });

  it('should correctly introspect telegram template (poll ingestor, token in URL not headers)', () => {
    const templates = listConnectionTemplates();
    const telegram = templates.find((t) => t.alias === 'telegram')!;

    expect(telegram.name).toBe('Telegram Bot API');
    // Token is in URL path, not headers — so it's optional by header-classification
    expect(telegram.requiredSecrets).toEqual([]);
    expect(telegram.optionalSecrets).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(telegram.hasIngestor).toBe(true);
    expect(telegram.ingestorType).toBe('poll');
  });

  it('should correctly introspect discord-bot template (websocket ingestor)', () => {
    const templates = listConnectionTemplates();
    const discord = templates.find((t) => t.alias === 'discord-bot')!;

    expect(discord.name).toBe('Discord Bot API');
    expect(discord.requiredSecrets).toEqual(['DISCORD_BOT_TOKEN']);
    expect(discord.optionalSecrets).toEqual([]);
    expect(discord.hasIngestor).toBe(true);
    expect(discord.ingestorType).toBe('websocket');
  });

  it('should correctly introspect trello template (multiple secrets, webhook ingestor)', () => {
    const templates = listConnectionTemplates();
    const trello = templates.find((t) => t.alias === 'trello')!;

    expect(trello.name).toBe('Trello API');
    // Trello has no auth headers — uses query-string auth
    expect(trello.hasIngestor).toBe(true);
    expect(trello.ingestorType).toBe('webhook');
    // All secrets should be accounted for
    const allSecrets = [...trello.requiredSecrets, ...trello.optionalSecrets].sort();
    expect(allSecrets).toEqual(Object.keys(loadConnection('trello').secrets ?? {}).sort());
  });
});

// ── listConnectionTemplates — new boolean fields ────────────────────────

describe('listConnectionTemplates — new boolean fields (unit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report hasTestConnection=true when testConnection is present', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        testConnection: { url: 'https://api.example.com/me', description: 'Test' },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasTestConnection).toBe(true);
  });

  it('should report hasTestConnection=false when testConnection is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasTestConnection).toBe(false);
  });

  it('should report hasTestIngestor=true when testIngestor is present', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        testIngestor: {
          description: 'Verify webhook',
          strategy: 'webhook_verify',
          requireSecrets: ['SECRET'],
        },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasTestIngestor).toBe(true);
  });

  it('should report hasTestIngestor=false when testIngestor is null', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        testIngestor: null,
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasTestIngestor).toBe(false);
  });

  it('should report hasTestIngestor=false when testIngestor is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasTestIngestor).toBe(false);
  });

  it('should report hasListenerConfig=true when listenerConfig is present', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        listenerConfig: {
          name: 'API Listener',
          fields: [{ key: 'eventFilter', label: 'Events', type: 'multiselect' }],
        },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasListenerConfig).toBe(true);
  });

  it('should report hasListenerConfig=false when listenerConfig is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].hasListenerConfig).toBe(false);
  });

  it('should correctly report all three boolean fields together', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['full.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'Full API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        testConnection: { url: 'https://api.example.com/me' },
        testIngestor: { description: 'Test', strategy: 'webhook_verify' },
        listenerConfig: { name: 'Listener', fields: [] },
      }),
    );

    const templates = listConnectionTemplates();
    const t = templates[0];
    expect(t.hasTestConnection).toBe(true);
    expect(t.hasTestIngestor).toBe(true);
    expect(t.hasListenerConfig).toBe(true);
  });
});

describe('listConnectionTemplates — new boolean fields (integration)', () => {
  it('should report hasTestConnection=true for all bundled templates', () => {
    // All 22 templates now have testConnection
    const templates = listConnectionTemplates();
    for (const t of templates) {
      expect(t.hasTestConnection).toBe(true);
    }
  });

  it('should report hasTestIngestor=true for templates with ingestors', () => {
    const templates = listConnectionTemplates();
    const withIngestors = templates.filter((t) => t.hasIngestor);
    expect(withIngestors.length).toBeGreaterThan(0);

    for (const t of withIngestors) {
      expect(t.hasTestIngestor).toBe(true);
    }
  });

  it('should report hasListenerConfig=true for templates with ingestors', () => {
    const templates = listConnectionTemplates();
    const withIngestors = templates.filter((t) => t.hasIngestor);
    expect(withIngestors.length).toBeGreaterThan(0);

    for (const t of withIngestors) {
      expect(t.hasListenerConfig).toBe(true);
    }
  });

  it('should report hasTestIngestor=false for templates without ingestors', () => {
    const templates = listConnectionTemplates();
    const withoutIngestors = templates.filter((t) => !t.hasIngestor);
    expect(withoutIngestors.length).toBeGreaterThan(0);

    for (const t of withoutIngestors) {
      expect(t.hasTestIngestor).toBe(false);
    }
  });

  it('should report hasListenerConfig=false for templates without ingestors', () => {
    const templates = listConnectionTemplates();
    const withoutIngestors = templates.filter((t) => !t.hasIngestor);
    expect(withoutIngestors.length).toBeGreaterThan(0);

    for (const t of withoutIngestors) {
      expect(t.hasListenerConfig).toBe(false);
    }
  });
});

// ── Multi-instance support fields ────────────────────────────────────────

describe('listConnectionTemplates — supportsMultiInstance field (unit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report supportsMultiInstance=true when listenerConfig has supportsMultiInstance', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        listenerConfig: {
          name: 'API Listener',
          supportsMultiInstance: true,
          fields: [
            { key: 'boardId', label: 'Board', type: 'text', instanceKey: true },
            { key: 'bufferSize', label: 'Buffer', type: 'number' },
          ],
        },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].supportsMultiInstance).toBe(true);
  });

  it('should report supportsMultiInstance=false when listenerConfig omits it', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
        ingestor: { type: 'webhook', webhook: { path: 'api' } },
        listenerConfig: {
          name: 'API Listener',
          fields: [{ key: 'eventFilter', label: 'Events', type: 'multiselect' }],
        },
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].supportsMultiInstance).toBe(false);
  });

  it('should report supportsMultiInstance=false when no listenerConfig exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValue(mockReaddirSync(['api.json']));
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        name: 'API',
        allowedEndpoints: ['https://api.example.com/**'],
      }),
    );

    const templates = listConnectionTemplates();
    expect(templates[0].supportsMultiInstance).toBe(false);
  });
});

describe('listConnectionTemplates — supportsMultiInstance (integration)', () => {
  it('should report supportsMultiInstance=true for trello, reddit, and github', () => {
    const templates = listConnectionTemplates();

    const trello = templates.find((t) => t.alias === 'trello')!;
    expect(trello.supportsMultiInstance).toBe(true);

    const reddit = templates.find((t) => t.alias === 'reddit')!;
    expect(reddit.supportsMultiInstance).toBe(true);

    const github = templates.find((t) => t.alias === 'github')!;
    expect(github.supportsMultiInstance).toBe(true);
  });

  it('should report supportsMultiInstance=false for connections without multi-instance support', () => {
    const templates = listConnectionTemplates();

    // Connections without ingestors should not support multi-instance
    const anthropic = templates.find((t) => t.alias === 'anthropic')!;
    expect(anthropic.supportsMultiInstance).toBe(false);

    const openai = templates.find((t) => t.alias === 'openai')!;
    expect(openai.supportsMultiInstance).toBe(false);
  });
});

// ── Connection template JSON structure validation ──────────────────────

describe('connection template JSON structure validation', () => {
  const templates = listConnectionTemplates();
  const withIngestors = templates.filter((t) => t.hasIngestor);
  const withoutIngestors = templates.filter((t) => !t.hasIngestor);

  it('should have templates in both categories', () => {
    expect(withIngestors.length).toBeGreaterThan(0);
    expect(withoutIngestors.length).toBeGreaterThan(0);
  });

  it('should have valid testConnection URL for all templates', () => {
    for (const t of templates) {
      const route = loadConnection(t.alias);
      expect(route.testConnection).toBeDefined();
      expect(route.testConnection!.url).toBeTruthy();
      expect(typeof route.testConnection!.url).toBe('string');
    }
  });

  it('should have testConnection descriptions for all templates', () => {
    for (const t of templates) {
      const route = loadConnection(t.alias);
      if (route.testConnection?.description) {
        expect(typeof route.testConnection.description).toBe('string');
        expect(route.testConnection.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have valid testIngestor config for templates with ingestors', () => {
    for (const t of withIngestors) {
      const route = loadConnection(t.alias);
      expect(route.testIngestor).toBeDefined();

      const ti = route.testIngestor!;
      expect(ti.description).toBeTruthy();
      expect(['websocket_auth', 'webhook_verify', 'poll_once', 'http_request']).toContain(ti.strategy);

      // http_request and websocket_auth strategies must have a request
      if (ti.strategy === 'http_request' || ti.strategy === 'websocket_auth' || ti.strategy === 'poll_once') {
        expect(ti.request).toBeDefined();
        expect(ti.request!.url).toBeTruthy();
      }

      // webhook_verify strategy should have requireSecrets
      if (ti.strategy === 'webhook_verify') {
        expect(ti.requireSecrets).toBeDefined();
        expect(Array.isArray(ti.requireSecrets)).toBe(true);
        expect(ti.requireSecrets!.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have valid listenerConfig for templates with ingestors', () => {
    for (const t of withIngestors) {
      const route = loadConnection(t.alias);
      expect(route.listenerConfig).toBeDefined();

      const lc = route.listenerConfig!;
      expect(lc.name).toBeTruthy();
      expect(Array.isArray(lc.fields)).toBe(true);
      expect(lc.fields.length).toBeGreaterThan(0);

      // Validate each field has required properties
      for (const field of lc.fields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        expect(['text', 'number', 'boolean', 'select', 'multiselect', 'secret', 'text[]']).toContain(field.type);

        // Select/multiselect fields should have options
        if (field.type === 'select' || field.type === 'multiselect') {
          if (field.options) {
            for (const opt of field.options) {
              expect(opt.value).toBeDefined();
              expect(opt.label).toBeTruthy();
            }
          }
        }

        // Number fields should have valid min/max
        if (field.type === 'number') {
          if (field.min !== undefined && field.max !== undefined) {
            expect(field.min).toBeLessThanOrEqual(field.max);
          }
        }

        // Dynamic options should have required fields
        if (field.dynamicOptions) {
          expect(field.dynamicOptions.url).toBeTruthy();
          expect(field.dynamicOptions.labelField).toBeTruthy();
          expect(field.dynamicOptions.valueField).toBeTruthy();
        }
      }
    }
  });

  it('should have at most one instanceKey field per listenerConfig', () => {
    for (const t of withIngestors) {
      const route = loadConnection(t.alias);
      if (route.listenerConfig) {
        const instanceKeyFields = route.listenerConfig.fields.filter((f) => f.instanceKey);
        expect(instanceKeyFields.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('should have instanceKey fields only on multi-instance connections', () => {
    for (const t of templates) {
      const route = loadConnection(t.alias);
      if (route.listenerConfig) {
        const hasInstanceKeyField = route.listenerConfig.fields.some((f) => f.instanceKey);
        if (hasInstanceKeyField) {
          expect(route.listenerConfig.supportsMultiInstance).toBe(true);
        }
      }
    }
  });

  it('should have multi-instance connections declare an instanceKey field', () => {
    for (const t of templates) {
      const route = loadConnection(t.alias);
      if (route.listenerConfig?.supportsMultiInstance) {
        const hasInstanceKeyField = route.listenerConfig.fields.some((f) => f.instanceKey);
        expect(hasInstanceKeyField).toBe(true);
      }
    }
  });

  it('should not have testIngestor or listenerConfig for templates without ingestors', () => {
    for (const t of withoutIngestors) {
      const route = loadConnection(t.alias);
      expect(route.testIngestor).toBeUndefined();
      expect(route.listenerConfig).toBeUndefined();
    }
  });

  it('should have github template with correct testConnection config', () => {
    const route = loadConnection('github');
    expect(route.testConnection).toEqual({
      url: expect.stringContaining('api.github.com'),
      description: expect.any(String),
    });
  });

  it('should have slack template with correct testConnection config', () => {
    const route = loadConnection('slack');
    expect(route.testConnection).toBeDefined();
    expect(route.testConnection!.url).toContain('slack.com');
    expect(route.testConnection!.method).toBe('POST');
  });

  it('should have trello template with correct testConnection config', () => {
    const route = loadConnection('trello');
    expect(route.testConnection).toBeDefined();
    expect(route.testConnection!.url).toContain('api.trello.com');
    // Trello uses query-string auth, so no special headers needed
  });

  it('should have discord-bot template with all new fields', () => {
    const route = loadConnection('discord-bot');
    expect(route.testConnection).toBeDefined();
    expect(route.testIngestor).toBeDefined();
    expect(route.listenerConfig).toBeDefined();

    // listenerConfig should have expected fields
    const fieldKeys = route.listenerConfig!.fields.map((f) => f.key);
    expect(fieldKeys).toContain('eventFilter');
    expect(fieldKeys).toContain('bufferSize');
  });

  it('should have all listenerConfig fields with groups', () => {
    for (const t of withIngestors) {
      const route = loadConnection(t.alias);
      if (route.listenerConfig) {
        for (const field of route.listenerConfig.fields) {
          // All fields should have a group for UI organization
          expect(field.group).toBeTruthy();
        }
      }
    }
  });
});
