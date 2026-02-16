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
export {};
//# sourceMappingURL=generate-keys.d.ts.map