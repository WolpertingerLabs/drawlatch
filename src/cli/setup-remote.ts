#!/usr/bin/env node
/**
 * Remote server setup CLI.
 *
 * Handles only the remote (secrets-holding) server side:
 *   1. Generating a keypair for the remote server
 *   2. Optionally importing the MCP proxy client's public keys
 *   3. Configuring server binding, routes, secrets, and headers
 *   4. Writing remote.config.json
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
} from '../shared/config.js';
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
  2. Optionally import the MCP proxy client's public keys
  3. Configure server binding, routes, secrets, and headers
  4. Write remote.config.json
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

    console.log(`\n  Public keys to share with the MCP proxy client:`);
    console.log(`    ${path.join(REMOTE_KEYS_DIR, 'signing.pub.pem')}`);
    console.log(`    ${path.join(REMOTE_KEYS_DIR, 'exchange.pub.pem')}`);

    // Step 2: Import MCP proxy client's public keys (optional)
    console.log('\n─── Step 2: Import MCP proxy client public keys (optional) ───\n');
    console.log('  If the MCP proxy has already been set up, provide the path to');
    console.log('  its public keys directory (containing signing.pub.pem and exchange.pub.pem).\n');

    const importPath = await ask(rl, '  Path to MCP proxy public keys (empty to skip)');

    if (importPath) {
      if (
        fs.existsSync(path.join(importPath, 'signing.pub.pem')) &&
        fs.existsSync(path.join(importPath, 'exchange.pub.pem'))
      ) {
        const clientName = await ask(rl, '  Client name', 'mcp-proxy');
        const dest = path.join(PEER_KEYS_DIR, 'authorized-clients', clientName);
        copyPublicKeys(importPath, dest);
        console.log(`  ✓ Imported client public keys → ${dest}`);
      } else {
        console.log('  ⚠ Could not find signing.pub.pem and exchange.pub.pem in that directory.');
        console.log('    You can import them later by copying them to:');
        console.log(`    ${path.join(PEER_KEYS_DIR, 'authorized-clients', '<client-name>')}`);
      }
    } else {
      console.log("  Skipped. You can import them later by copying the proxy's");
      console.log(
        `  public key files to: ${path.join(PEER_KEYS_DIR, 'authorized-clients', '<client-name>')}`,
      );
    }

    // Step 3: Server configuration
    console.log('\n─── Step 3: Server Configuration ───\n');

    console.log('  Bind host controls which network interface the server listens on.');
    console.log('    0.0.0.0     — accept connections from any network (typical for remote servers)');
    console.log('    127.0.0.1   — local connections only (use if behind a reverse proxy)\n');

    const host = await ask(rl, '  Host to bind', '0.0.0.0');
    const port = await ask(rl, '  Port to listen on', '9999');

    // Step 4: Route configuration
    console.log('\n─── Step 4: Route Configuration ───\n');
    console.log('  Configure routes (each route scopes secrets and headers to endpoint patterns).');
    console.log('  Enter endpoint patterns first, then headers and secrets for each route.');
    console.log('  Press Enter with empty pattern to finish adding routes.\n');

    const routes: Route[] = [];
    let addingRoutes = true;
    let routeIndex = 1;

    while (addingRoutes) {
      console.log(`\n  ── Route ${routeIndex} ──`);

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
        addingRoutes = false;
        break;
      }

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
      console.log('  Secrets for this route (env var references like ${API_KEY})');
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

      routes.push({
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
        allowedEndpoints: endpointPatterns,
      });
      routeIndex++;

      const addMore = await ask(rl, '  Add another route? (y/n)', 'n');
      if (addMore.toLowerCase() !== 'y') {
        addingRoutes = false;
      }
    }

    const config: RemoteServerConfig = {
      host,
      port: parseInt(port, 10),
      localKeysDir: REMOTE_KEYS_DIR,
      authorizedPeersDir: path.join(PEER_KEYS_DIR, 'authorized-clients'),
      routes,
      rateLimitPerMinute: 60,
    };

    saveRemoteConfig(config);
    console.log(`\n  ✓ Remote config saved to ${REMOTE_CONFIG_PATH}`);

    console.log('\n✓ Remote setup complete!\n');
    console.log('Next steps:');
    console.log(`  1. Share your public keys with the MCP proxy operator:`);
    console.log(`     ${REMOTE_KEYS_DIR}/signing.pub.pem`);
    console.log(`     ${REMOTE_KEYS_DIR}/exchange.pub.pem`);
    console.log("  2. If you haven't imported the proxy client's public keys yet,");
    console.log(
      `     copy them to: ${path.join(PEER_KEYS_DIR, 'authorized-clients', '<client-name>')}`,
    );
    console.log(`  3. Review/edit routes in the config: ${REMOTE_CONFIG_PATH}`);
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
  - Optionally imports the MCP proxy client's public keys
  - Configures server binding (host, port)
  - Interactive route configuration (endpoints, headers, secrets)
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
