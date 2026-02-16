#!/usr/bin/env node
/**
 * Interactive setup CLI for mcp-secure-proxy.
 *
 * Handles:
 *   1. Generating keypairs for both local and remote sides
 *   2. Exchanging public keys (copying pub keys to peer directories)
 *   3. Configuring secrets on the remote server
 *   4. Generating the Claude Code MCP server config snippet
 *   5. Writing the config file
 *
 * Usage:
 *   npx tsx src/cli/setup.ts               # Full interactive setup
 *   npx tsx src/cli/setup.ts init           # Generate everything with defaults
 *   npx tsx src/cli/setup.ts exchange       # Exchange keys after manual setup
 *   npx tsx src/cli/setup.ts claude-config  # Print Claude Code MCP config
 */
export {};
//# sourceMappingURL=setup.d.ts.map