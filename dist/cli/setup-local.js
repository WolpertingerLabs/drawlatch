#!/usr/bin/env node
/**
 * Local (proxy) setup CLI.
 *
 * Handles only the MCP proxy side:
 *   1. Generating a keypair for the local MCP proxy
 *   2. Optionally importing the remote server's public keys
 *   3. Configuring proxy connection settings
 *   4. Writing proxy.config.json
 *   5. Printing the `claude mcp add` command
 *
 * Usage:
 *   npx tsx src/cli/setup-local.ts               # Interactive setup
 *   npx tsx src/cli/setup-local.ts --help         # Show help
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyBundle, saveKeyBundle, extractPublicKeys, fingerprint, loadKeyBundle, } from '../shared/crypto/index.js';
import { CONFIG_DIR, LOCAL_KEYS_DIR, PEER_KEYS_DIR, PROXY_CONFIG_PATH, saveProxyConfig, } from '../shared/config.js';
import { createReadline, ask, ensureDir, copyPublicKeys, printClaudeConfig } from './helpers.js';
// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
    const rl = createReadline();
    try {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║          MCP Secure Proxy — Local (Proxy) Setup             ║
╚══════════════════════════════════════════════════════════════╝

This will:
  1. Generate a keypair for the MCP proxy (local)
  2. Optionally import the remote server's public keys
  3. Configure proxy connection settings
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
        }
        else {
            localBundle = generateKeyBundle();
            saveKeyBundle(localBundle, LOCAL_KEYS_DIR);
            const fp = fingerprint(extractPublicKeys(localBundle));
            console.log(`  ✓ Generated local keys (fingerprint: ${fp})`);
        }
        console.log(`\n  Public keys to share with the remote server:`);
        console.log(`    ${path.join(LOCAL_KEYS_DIR, 'signing.pub.pem')}`);
        console.log(`    ${path.join(LOCAL_KEYS_DIR, 'exchange.pub.pem')}`);
        // Step 2: Import remote server's public keys (optional)
        console.log('\n─── Step 2: Import remote server public keys (optional) ───\n');
        console.log('  If the remote server has already been set up, provide the path to');
        console.log('  its public keys directory (containing signing.pub.pem and exchange.pub.pem).\n');
        const importPath = await ask(rl, '  Path to remote server public keys (empty to skip)');
        const remoteForProxy = path.join(PEER_KEYS_DIR, 'remote-server');
        if (importPath) {
            if (fs.existsSync(path.join(importPath, 'signing.pub.pem')) &&
                fs.existsSync(path.join(importPath, 'exchange.pub.pem'))) {
                copyPublicKeys(importPath, remoteForProxy);
                console.log(`  ✓ Imported remote public keys → ${remoteForProxy}`);
            }
            else {
                console.log('  ⚠ Could not find signing.pub.pem and exchange.pub.pem in that directory.');
                console.log('    You can import them later by copying them to:');
                console.log(`    ${remoteForProxy}`);
            }
        }
        else {
            console.log("  Skipped. You can import them later by copying the remote server's");
            console.log(`  public key files to: ${remoteForProxy}`);
        }
        // Step 3: Configure proxy settings
        console.log('\n─── Step 3: Configuration ───\n');
        const host = await ask(rl, '  Remote server host', '127.0.0.1');
        const port = await ask(rl, '  Remote server port', '9999');
        const config = {
            remoteUrl: `http://${host}:${port}`,
            localKeysDir: LOCAL_KEYS_DIR,
            remotePublicKeysDir: remoteForProxy,
            connectTimeout: 10_000,
            requestTimeout: 30_000,
        };
        saveProxyConfig(config);
        console.log(`\n  ✓ Proxy config saved to ${PROXY_CONFIG_PATH}`);
        // Step 4: Print claude mcp add command
        console.log('\n─── Step 4: Register MCP Server with Claude Code ───\n');
        printClaudeConfig();
        console.log('\n✓ Local setup complete!\n');
        console.log('Next steps:');
        console.log(`  1. Share your public keys with the remote server operator:`);
        console.log(`     ${LOCAL_KEYS_DIR}/signing.pub.pem`);
        console.log(`     ${LOCAL_KEYS_DIR}/exchange.pub.pem`);
        console.log("  2. If you haven't imported the remote server's public keys yet,");
        console.log(`     copy them to: ${remoteForProxy}`);
        console.log('  3. Run the `claude mcp add` command printed above');
        console.log('  4. Restart Claude Code\n');
    }
    finally {
        rl.close();
    }
}
// ── Entry point ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
MCP Secure Proxy — Local (Proxy) Setup

Sets up only the local MCP proxy side:
  - Generates a local keypair
  - Optionally imports the remote server's public keys
  - Configures proxy connection settings (host, port)
  - Writes proxy.config.json
  - Prints the \`claude mcp add\` command

Usage:
  setup-local          Interactive local setup
  setup-local --help   Show this help
`);
}
else {
    main().catch((err) => {
        console.error('Local setup failed:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=setup-local.js.map