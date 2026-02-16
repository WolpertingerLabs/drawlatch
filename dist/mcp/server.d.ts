/**
 * MCP Proxy Server — the local side.
 *
 * Claude Code spawns this as a child process (stdio transport).
 * It exposes MCP tools, encrypts requests, forwards them to the remote
 * secure server over HTTP, decrypts responses, and returns them to Claude.
 *
 * The proxy holds NO secrets. It only has:
 *   - Its own Ed25519 + X25519 keypair (for authentication + encryption)
 *   - The remote server's public keys (for verifying the remote's identity)
 */
export {};
//# sourceMappingURL=server.d.ts.map