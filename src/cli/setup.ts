#!/usr/bin/env node
/**
 * Interactive setup CLI for mcp-secure-proxy.
 *
 * Handles:
 *   1. Generating keypairs for both local and remote sides
 *   2. Exchanging public keys (copying pub keys to peer directories)
 *   3. Configuring secrets on the remote server
 *   4. Printing the `claude mcp add` command to register the MCP server
 *   5. Writing the config file
 *
 * Usage:
 *   npx tsx src/cli/setup.ts               # Full interactive setup
 *   npx tsx src/cli/setup.ts init           # Generate everything with defaults
 *   npx tsx src/cli/setup.ts exchange       # Exchange keys after manual setup
 *   npx tsx src/cli/setup.ts claude-config  # Print Claude Code MCP config
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  generateKeyBundle,
  saveKeyBundle,
  extractPublicKeys,
  fingerprint,
  loadKeyBundle,
} from '../shared/crypto/index.js';
import {
  CONFIG_DIR,
  CONFIG_PATH,
  LOCAL_KEYS_DIR,
  REMOTE_KEYS_DIR,
  PEER_KEYS_DIR,
  saveConfig,
  type Config,
} from '../shared/config.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve((answer.trim() || defaultValue) ?? '');
    });
  });
}

function copyPublicKeys(sourceDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const file of ['signing.pub.pem', 'exchange.pub.pem']) {
    const src = path.join(sourceDir, file);
    const dst = path.join(destDir, file);
    fs.copyFileSync(src, dst);
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ── Commands ───────────────────────────────────────────────────────────────

async function fullInit(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║            MCP Secure Proxy — Initial Setup                 ║
╚══════════════════════════════════════════════════════════════╝

This will:
  1. Generate keypairs for the MCP proxy (local) and remote server
  2. Exchange public keys between both sides
  3. Create a default config file
  4. Print the \`claude mcp add\` command to register the MCP server
`);

  ensureDir(CONFIG_DIR);

  // Step 1: Generate local keys
  console.log('─── Step 1: Generate MCP Proxy (local) keypair ───\n');
  let localBundle;
  if (fs.existsSync(path.join(LOCAL_KEYS_DIR, 'signing.key.pem'))) {
    localBundle = loadKeyBundle(LOCAL_KEYS_DIR);
    const fp = fingerprint(extractPublicKeys(localBundle));
    console.log(`  ✓ Local keys already exist (fingerprint: ${fp})`);
  } else {
    localBundle = generateKeyBundle();
    saveKeyBundle(localBundle, LOCAL_KEYS_DIR);
    const fp = fingerprint(extractPublicKeys(localBundle));
    console.log(`  ✓ Generated local keys (fingerprint: ${fp})`);
  }

  // Step 2: Generate remote keys
  console.log('\n─── Step 2: Generate Remote Server keypair ───\n');
  let remoteBundle;
  if (fs.existsSync(path.join(REMOTE_KEYS_DIR, 'signing.key.pem'))) {
    remoteBundle = loadKeyBundle(REMOTE_KEYS_DIR);
    const fp = fingerprint(extractPublicKeys(remoteBundle));
    console.log(`  ✓ Remote keys already exist (fingerprint: ${fp})`);
  } else {
    remoteBundle = generateKeyBundle();
    saveKeyBundle(remoteBundle, REMOTE_KEYS_DIR);
    const fp = fingerprint(extractPublicKeys(remoteBundle));
    console.log(`  ✓ Generated remote keys (fingerprint: ${fp})`);
  }

  // Step 3: Exchange public keys
  console.log('\n─── Step 3: Exchange public keys ───\n');

  // Copy remote's public keys to the proxy's peer directory
  const remoteForProxy = path.join(PEER_KEYS_DIR, 'remote-server');
  copyPublicKeys(REMOTE_KEYS_DIR, remoteForProxy);
  console.log(`  ✓ Remote server public keys → ${remoteForProxy}`);

  // Copy local's public keys to the remote's authorized peers directory
  const localForRemote = path.join(PEER_KEYS_DIR, 'authorized-clients', 'mcp-proxy');
  copyPublicKeys(LOCAL_KEYS_DIR, localForRemote);
  console.log(`  ✓ MCP proxy public keys → ${localForRemote}`);

  // Step 4: Configure
  console.log('\n─── Step 4: Configuration ───\n');

  const port = await ask('Remote server port', '9999');
  const host = await ask('Remote server host', '127.0.0.1');

  const config: Config = {
    proxy: {
      remoteUrl: `http://${host}:${port}`,
      localKeysDir: LOCAL_KEYS_DIR,
      remotePublicKeysDir: remoteForProxy,
      connectTimeout: 10_000,
      requestTimeout: 30_000,
    },
    remote: {
      host,
      port: parseInt(port, 10),
      localKeysDir: REMOTE_KEYS_DIR,
      authorizedPeersDir: path.join(PEER_KEYS_DIR, 'authorized-clients'),
      secrets: {},
      allowedEndpoints: [],
      rateLimitPerMinute: 60,
    },
  };

  // Add secrets
  console.log('\n  Configure secrets (env var references like ${API_KEY}):');
  console.log('  Press Enter with empty name to finish.\n');

  let addingSecrets = true;
  while (addingSecrets) {
    const name = await ask('  Secret name (empty to finish)');
    if (!name) {
      addingSecrets = false;
    } else {
      const value = await ask(`  Value for "${name}" (use \${VAR} for env vars)`, `\${${name}}`);
      config.remote.secrets[name] = value;
    }
  }

  // Add endpoint allowlist
  console.log('\n  Allowed endpoint patterns (glob, e.g. https://api.example.com/**)');
  console.log('  Leave empty to allow all endpoints.\n');

  let addingEndpoints = true;
  while (addingEndpoints) {
    const pattern = await ask('  Endpoint pattern (empty to finish)');
    if (!pattern) {
      addingEndpoints = false;
    } else {
      config.remote.allowedEndpoints.push(pattern);
    }
  }

  saveConfig(config);
  console.log(`\n  ✓ Config saved to ${CONFIG_PATH}`);

  // Step 5: Print claude mcp add command
  console.log('\n─── Step 5: Register MCP Server with Claude Code ───\n');
  printClaudeConfig();

  rl.close();
  console.log('\n✓ Setup complete!\n');
  console.log('Next steps:');
  console.log(`  1. Add secrets to the config: edit ${CONFIG_PATH}`);
  console.log('  2. Start the remote server: npm run dev:remote');
  console.log('  3. Run the `claude mcp add` command printed above');
  console.log('  4. Restart Claude Code\n');
}

function printClaudeConfig(): void {
  const mcpServerPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../mcp/server.ts',
  );

  // For compiled version
  const compiledPath = mcpServerPath.replace('/src/', '/dist/').replace('.ts', '.js');

  // Absolute path to the config dir so the MCP proxy can find keys regardless of cwd
  const configDir = path.resolve(CONFIG_DIR);

  console.log('  Run one of the following commands to register the MCP server:\n');
  console.log('  For development (tsx):');
  console.log(
    `    claude mcp add --transport stdio --scope local \\`,
  );
  console.log(
    `      --env MCP_CONFIG_DIR=${configDir} \\`,
  );
  console.log(
    `      secure-proxy -- npx tsx ${mcpServerPath}`,
  );

  console.log('\n  For production (compiled):');
  console.log(
    `    claude mcp add --transport stdio --scope local \\`,
  );
  console.log(
    `      --env MCP_CONFIG_DIR=${configDir} \\`,
  );
  console.log(
    `      secure-proxy -- node ${compiledPath}`,
  );
}

function exchangeKeys(): void {
  console.log('\n─── Exchanging public keys ───\n');

  if (!fs.existsSync(path.join(LOCAL_KEYS_DIR, 'signing.pub.pem'))) {
    console.error('Error: Local keys not found. Run "generate-keys local" first.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(REMOTE_KEYS_DIR, 'signing.pub.pem'))) {
    console.error('Error: Remote keys not found. Run "generate-keys remote" first.');
    process.exit(1);
  }

  const remoteForProxy = path.join(PEER_KEYS_DIR, 'remote-server');
  copyPublicKeys(REMOTE_KEYS_DIR, remoteForProxy);
  console.log(`✓ Remote server public keys → ${remoteForProxy}`);

  const localForRemote = path.join(PEER_KEYS_DIR, 'authorized-clients', 'mcp-proxy');
  copyPublicKeys(LOCAL_KEYS_DIR, localForRemote);
  console.log(`✓ MCP proxy public keys → ${localForRemote}`);

  console.log('\n✓ Key exchange complete\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

const command = process.argv[2] || 'init';

switch (command) {
  case 'init':
    fullInit().catch((err: unknown) => {
      console.error('Setup failed:', err);
      rl.close();
      process.exit(1);
    });
    break;

  case 'exchange':
    exchangeKeys();
    break;

  case 'claude-config':
    printClaudeConfig();
    break;

  case '--help':
  case '-h':
    console.log(`
Usage:
  setup init            Full interactive setup (default)
  setup exchange        Exchange public keys between local and remote
  setup claude-config   Print the \`claude mcp add\` command
`);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
