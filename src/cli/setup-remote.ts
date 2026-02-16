#!/usr/bin/env node
/**
 * Remote server setup CLI.
 *
 * Handles only the remote (secrets-holding) server side:
 *   1. Generating a keypair for the remote server
 *   2. Configuring server binding
 *   3. Defining custom connectors (endpoints, headers, secrets)
 *   4. Setting up callers (peer keys, connection access)
 *   5. Writing remote.config.json
 *
 * Usage:
 *   npx tsx src/cli/setup-remote.ts               # Interactive setup
 *   npx tsx src/cli/setup-remote.ts --help         # Show help
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  generateKeyBundle,
  saveKeyBundle,
  extractPublicKeys,
  fingerprint,
  loadKeyBundle,
} from '../shared/crypto/index.js';
import {
  CONFIG_DIR,
  REMOTE_KEYS_DIR,
  PEER_KEYS_DIR,
  REMOTE_CONFIG_PATH,
  saveRemoteConfig,
  type RemoteServerConfig,
  type Route,
  type CallerConfig,
} from '../shared/config.js';
import { listAvailableConnections } from '../shared/connections.js';
import { createReadline, ask, ensureDir, copyPublicKeys } from './helpers.js';

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rl = createReadline();

  try {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║        MCP Secure Proxy — Remote Server Setup               ║
╚══════════════════════════════════════════════════════════════╝

This will:
  1. Generate a keypair for the remote server
  2. Configure server binding
  3. Define custom connectors (optional)
  4. Set up callers (peer keys + connection access)
  5. Write remote.config.json
`);

    ensureDir(CONFIG_DIR);

    // Step 1: Generate remote keys
    console.log('─── Step 1: Generate Remote Server keypair ───\n');
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

    console.log(`\n  Public keys to share with MCP proxy clients:`);
    console.log(`    ${path.join(REMOTE_KEYS_DIR, 'signing.pub.pem')}`);
    console.log(`    ${path.join(REMOTE_KEYS_DIR, 'exchange.pub.pem')}`);

    // Step 2: Server configuration
    console.log('\n─── Step 2: Server Configuration ───\n');

    console.log('  Bind host controls which network interface the server listens on.');
    console.log(
      '    0.0.0.0     — accept connections from any network (typical for remote servers)',
    );
    console.log('    127.0.0.1   — local connections only (use if behind a reverse proxy)\n');

    const host = await ask(rl, '  Host to bind', '0.0.0.0');
    const port = await ask(rl, '  Port to listen on', '9999');

    // Step 3: Custom connectors
    console.log('\n─── Step 3: Custom Connectors (optional) ───\n');
    console.log('  Define custom connectors (each scopes secrets and headers to endpoint patterns).');
    console.log('  These are referenced by alias from caller connection lists.');
    console.log('  Press Enter with empty alias to finish adding connectors.\n');

    const connectors: Route[] = [];
    let addingConnectors = true;
    let connectorIndex = 1;

    while (addingConnectors) {
      console.log(`\n  ── Connector ${connectorIndex} ──`);

      const alias = await ask(rl, '  Connector alias (e.g., "admin-api", empty to finish)');
      if (!alias) {
        addingConnectors = false;
        break;
      }

      const connectorName = await ask(rl, '  Display name (e.g., "Internal Admin API", empty to skip)');

      // Endpoint patterns (required)
      const endpointPatterns: string[] = [];
      console.log('  Endpoint patterns (glob, e.g. https://api.example.com/**)');
      let addingEndpoints = true;
      while (addingEndpoints) {
        const pattern = await ask(rl, '    Endpoint pattern (empty to finish)');
        if (!pattern) {
          addingEndpoints = false;
        } else {
          endpointPatterns.push(pattern);
        }
      }

      if (endpointPatterns.length === 0) {
        console.log('  ⚠ No endpoint patterns — skipping this connector.');
        continue;
      }

      const connectorDescription = await ask(rl, '  Description (empty to skip)');
      const connectorDocsUrl = await ask(rl, '  API docs URL (empty to skip)');
      const connectorOpenApiUrl = await ask(rl, '  OpenAPI spec URL (empty to skip)');

      // Headers
      const headers: Record<string, string> = {};
      console.log('  Headers to auto-inject (e.g., Authorization: Bearer ${API_KEY})');
      let addingHeaders = true;
      while (addingHeaders) {
        const name = await ask(rl, '    Header name (empty to finish)');
        if (!name) {
          addingHeaders = false;
        } else {
          const value = await ask(rl, `    Value for "${name}"`);
          headers[name] = value;
        }
      }

      // Secrets
      const secrets: Record<string, string> = {};
      console.log('  Secrets for this connector (env var references like ${API_KEY})');
      let addingSecrets = true;
      while (addingSecrets) {
        const name = await ask(rl, '    Secret name (empty to finish)');
        if (!name) {
          addingSecrets = false;
        } else {
          const value = await ask(
            rl,
            `    Value for "${name}" (use \${VAR} for env vars)`,
            `\${${name}}`,
          );
          secrets[name] = value;
        }
      }

      const connector: Route = {
        alias,
        allowedEndpoints: endpointPatterns,
      };
      if (connectorName) connector.name = connectorName;
      if (connectorDescription) connector.description = connectorDescription;
      if (connectorDocsUrl) connector.docsUrl = connectorDocsUrl;
      if (connectorOpenApiUrl) connector.openApiUrl = connectorOpenApiUrl;
      if (Object.keys(headers).length > 0) connector.headers = headers;
      if (Object.keys(secrets).length > 0) connector.secrets = secrets;

      connectors.push(connector);
      connectorIndex++;

      const addMore = await ask(rl, '  Add another connector? (y/n)', 'n');
      if (addMore.toLowerCase() !== 'y') {
        addingConnectors = false;
      }
    }

    // Step 4: Set up callers
    console.log('\n─── Step 4: Caller Configuration ───\n');
    console.log('  Each caller is identified by a unique alias (e.g., "laptop", "ci-server").');
    console.log('  Each caller specifies their peer key directory and which connections they can use.\n');

    // Collect available connection names (built-in templates + custom connector aliases)
    const builtinConnections = listAvailableConnections();
    const customAliases = connectors.map((c) => c.alias!).filter(Boolean);
    const allAvailable = [...builtinConnections, ...customAliases];

    if (allAvailable.length > 0) {
      console.log('  Available connections:');
      if (builtinConnections.length > 0) {
        console.log('    Built-in templates: ' + builtinConnections.join(', '));
      }
      if (customAliases.length > 0) {
        console.log('    Custom connectors:  ' + customAliases.join(', '));
      }
      console.log('');
    }

    const callers: Record<string, CallerConfig> = {};
    let addingCallers = true;

    while (addingCallers) {
      const callerAlias = await ask(rl, '  Caller alias (e.g., "laptop", empty to finish)');
      if (!callerAlias) {
        addingCallers = false;
        break;
      }

      const callerName = await ask(rl, `  Display name for "${callerAlias}" (empty to skip)`);

      // Import or specify peer key path
      console.log(`\n  Peer keys for "${callerAlias}":`);
      const importPath = await ask(rl, '  Path to public keys directory (containing signing.pub.pem + exchange.pub.pem)');

      let peerKeyDir: string;
      if (
        importPath &&
        fs.existsSync(path.join(importPath, 'signing.pub.pem')) &&
        fs.existsSync(path.join(importPath, 'exchange.pub.pem'))
      ) {
        const dest = path.join(PEER_KEYS_DIR, callerAlias);
        copyPublicKeys(importPath, dest);
        peerKeyDir = dest;
        console.log(`  ✓ Imported public keys → ${dest}`);
      } else if (importPath) {
        console.log('  ⚠ Could not find key files. Using path as-is.');
        peerKeyDir = importPath;
      } else {
        peerKeyDir = path.join(PEER_KEYS_DIR, callerAlias);
        console.log(`  Using default path: ${peerKeyDir}`);
        console.log('  Copy the client\'s signing.pub.pem and exchange.pub.pem there before starting.');
      }

      // Select connections
      const connections: string[] = [];
      if (allAvailable.length > 0) {
        console.log(`\n  Select connections for "${callerAlias}":`);
        for (const conn of allAvailable) {
          const use = await ask(rl, `    Enable "${conn}"? (y/n)`, 'n');
          if (use.toLowerCase() === 'y') {
            connections.push(conn);
          }
        }
      }

      if (connections.length === 0) {
        console.log('  ⚠ No connections selected — this caller won\'t have access to any routes.');
      } else {
        console.log(`  ✓ Connections: ${connections.join(', ')}`);
      }

      const caller: CallerConfig = { peerKeyDir, connections };
      if (callerName) caller.name = callerName;
      callers[callerAlias] = caller;

      console.log('');
      const addMore = await ask(rl, '  Add another caller? (y/n)', 'n');
      if (addMore.toLowerCase() !== 'y') {
        addingCallers = false;
      }
    }

    const config: RemoteServerConfig = {
      host,
      port: parseInt(port, 10),
      localKeysDir: REMOTE_KEYS_DIR,
      ...(connectors.length > 0 && { connectors }),
      callers,
      rateLimitPerMinute: 60,
    };

    saveRemoteConfig(config);
    console.log(`\n  ✓ Remote config saved to ${REMOTE_CONFIG_PATH}`);

    console.log('\n✓ Remote setup complete!\n');
    console.log('Next steps:');
    console.log(`  1. Share your public keys with MCP proxy clients:`);
    console.log(`     ${REMOTE_KEYS_DIR}/signing.pub.pem`);
    console.log(`     ${REMOTE_KEYS_DIR}/exchange.pub.pem`);
    console.log("  2. Ensure each caller's public keys are in their configured peerKeyDir.");
    console.log(`  3. Review/edit config: ${REMOTE_CONFIG_PATH}`);
    console.log('  4. Start the remote server: npm run dev:remote\n');
  } finally {
    rl.close();
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
MCP Secure Proxy — Remote Server Setup

Sets up only the remote (secrets-holding) server side:
  - Generates a remote server keypair
  - Configures server binding (host, port)
  - Defines custom connectors (endpoints, headers, secrets)
  - Sets up callers (peer keys + connection access per caller)
  - Writes remote.config.json

Usage:
  setup-remote          Interactive remote setup
  setup-remote --help   Show this help
`);
} else {
  main().catch((err: unknown) => {
    console.error('Remote setup failed:', err);
    process.exit(1);
  });
}
