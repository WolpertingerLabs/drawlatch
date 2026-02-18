/**
 * Shared CLI helpers for setup scripts.
 *
 * Provides common utilities used by setup-local.ts, setup-remote.ts,
 * and the combined setup.ts.
 */
import { type Interface as ReadlineInterface } from 'node:readline';
export declare function createReadline(): ReadlineInterface;
export declare function ask(rl: ReadlineInterface, question: string, defaultValue?: string): Promise<string>;
export declare function copyPublicKeys(sourceDir: string, destDir: string): void;
export declare function ensureDir(dir: string): void;
export declare function printClaudeConfig(): void;
//# sourceMappingURL=helpers.d.ts.map