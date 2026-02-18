/**
 * Shared CLI helpers for setup scripts.
 *
 * Provides common utilities used by setup-local.ts, setup-remote.ts,
 * and the combined setup.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_DIR } from '../shared/config.js';
// ── Readline ─────────────────────────────────────────────────────────────────
export function createReadline() {
    return createInterface({ input: process.stdin, output: process.stdout });
}
export function ask(rl, question, defaultValue) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
            resolve((answer.trim() || defaultValue) ?? '');
        });
    });
}
// ── Filesystem ───────────────────────────────────────────────────────────────
export function copyPublicKeys(sourceDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    for (const file of ['signing.pub.pem', 'exchange.pub.pem']) {
        const src = path.join(sourceDir, file);
        const dst = path.join(destDir, file);
        fs.copyFileSync(src, dst);
    }
}
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
// ── Claude MCP registration ─────────────────────────────────────────────────
export function printClaudeConfig() {
    const mcpServerPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../mcp/server.ts');
    // For compiled version
    const compiledPath = mcpServerPath.replace('/src/', '/dist/').replace('.ts', '.js');
    // Absolute path to the config dir so the MCP proxy can find keys regardless of cwd
    const configDir = path.resolve(CONFIG_DIR);
    console.log('  Run one of the following commands to register the MCP server:\n');
    console.log('  For development (tsx):');
    console.log(`    claude mcp add secure-proxy \\`);
    console.log(`      --transport stdio --scope local \\`);
    console.log(`      -e MCP_CONFIG_DIR=${configDir} \\`);
    console.log(`      -- npx tsx ${mcpServerPath}`);
    console.log('\n  For production (compiled):');
    console.log(`    claude mcp add secure-proxy \\`);
    console.log(`      --transport stdio --scope local \\`);
    console.log(`      -e MCP_CONFIG_DIR=${configDir} \\`);
    console.log(`      -- node ${compiledPath}`);
}
//# sourceMappingURL=helpers.js.map