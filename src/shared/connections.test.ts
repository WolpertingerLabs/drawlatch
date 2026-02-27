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
