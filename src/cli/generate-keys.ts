#!/usr/bin/env node
/**
 * Key generation CLI.
 *
 * Generates Ed25519 (signing) + X25519 (key exchange) keypairs for either
 * the local MCP proxy or the remote server, and saves them with correct
 * file permissions (0600 for private keys, 0644 for public keys).
 *
 * Usage:
 *   npx tsx src/cli/generate-keys.ts local    # Generate MCP proxy keys
 *   npx tsx src/cli/generate-keys.ts remote   # Generate remote server keys
 *   npx tsx src/cli/generate-keys.ts --dir /path/to/keys  # Custom directory
 */

import {
  generateKeyBundle,
  saveKeyBundle,
  loadKeyBundle,
  fingerprint,
  extractPublicKeys,
} from '../crypto/index.js';
import { LOCAL_KEYS_DIR, REMOTE_KEYS_DIR, CONFIG_DIR } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

function usage(): void {
  console.log(`
mcp-secure-proxy key generation

Usage:
  generate-keys local           Generate MCP proxy (local) keypair
  generate-keys remote          Generate remote server keypair
  generate-keys --dir <path>    Generate keypair in a custom directory
  generate-keys show <path>     Show fingerprint of an existing keypair

Keys are saved as PEM files:
  <dir>/signing.pub.pem       Ed25519 public key (safe to share)
  <dir>/signing.key.pem       Ed25519 private key (keep secret!)
  <dir>/exchange.pub.pem      X25519 public key (safe to share)
  <dir>/exchange.key.pem      X25519 private key (keep secret!)
`);
}

function generateAndSave(targetDir: string, label: string): void {
  // Check if keys already exist
  if (fs.existsSync(path.join(targetDir, 'signing.key.pem'))) {
    console.error(`\n⚠️  Keys already exist in ${targetDir}`);
    console.error('   Delete them first if you want to regenerate.');

    const existing = loadKeyBundle(targetDir);
    const fp = fingerprint(extractPublicKeys(existing));
    console.log(`\n   Existing fingerprint: ${fp}\n`);
    process.exit(1);
  }

  console.log(`\nGenerating ${label} keypair...`);
  const bundle = generateKeyBundle();
  saveKeyBundle(bundle, targetDir);

  const pub = extractPublicKeys(bundle);
  const fp = fingerprint(pub);

  console.log(`\n✓ Keys saved to: ${targetDir}`);
  console.log(`  Fingerprint: ${fp}`);
  console.log(`\n  Files:`);
  console.log(`    ${path.join(targetDir, 'signing.pub.pem')}     (public, share this)`);
  console.log(`    ${path.join(targetDir, 'signing.key.pem')}     (PRIVATE, protect this)`);
  console.log(`    ${path.join(targetDir, 'exchange.pub.pem')}    (public, share this)`);
  console.log(`    ${path.join(targetDir, 'exchange.key.pem')}    (PRIVATE, protect this)`);
  console.log('');
}

function showFingerprint(dir: string): void {
  const bundle = loadKeyBundle(dir);
  const pub = extractPublicKeys(bundle);
  console.log(`Fingerprint: ${fingerprint(pub)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

// Ensure base config directory exists
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

if (args[0] === 'local') {
  generateAndSave(LOCAL_KEYS_DIR, 'MCP proxy (local)');
} else if (args[0] === 'remote') {
  generateAndSave(REMOTE_KEYS_DIR, 'remote server');
} else if (args[0] === '--dir' && args[1]) {
  generateAndSave(args[1], 'custom');
} else if (args[0] === 'show' && args[1]) {
  showFingerprint(args[1]);
} else {
  console.error(`Unknown argument: ${args[0]}`);
  usage();
  process.exit(1);
}
