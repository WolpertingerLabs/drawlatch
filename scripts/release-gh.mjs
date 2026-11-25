#!/usr/bin/env node

/**
 * Cut a GitHub release for the current package.json version, with the
 * `npm pack` tarball attached twice: once under its versioned npm name and
 * once as `drawlatch.tgz`.
 *
 * Usage:
 *   npm run release:gh
 *
 * Creates tag `v<version>` on GitHub at the current HEAD (gh creates the tag
 * itself; no local `git tag` needed) and marks the release as Latest.
 *
 * Consumers can then install without the npm registry. To always track the
 * newest release:
 *   "https://github.com/WolpertingerLabs/drawlatch/releases/latest/download/drawlatch.tgz"
 * To pin one version:
 *   "https://github.com/WolpertingerLabs/drawlatch/releases/download/v<version>/wolpertingerlabs-drawlatch-<version>.tgz"
 *
 * Releases are deliberately NOT marked as GitHub prereleases even though every
 * version is an alpha: GitHub's /releases/latest skips prereleases, so marking
 * them would leave the tracking URL above with nothing to resolve to.
 *
 * Refuses to run when the working tree is dirty, HEAD isn't on the remote, or
 * the release already exists, since each would publish something other than
 * what the tag points at. Requires an authenticated `gh` with write access.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const tarballName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
// Fixed asset name so /releases/latest/download/<name> always resolves.
const STABLE_ASSET = 'drawlatch.tgz';

console.log(`=== GitHub release ${tag} ===`);

// 1. Preconditions
if (capture('git', ['status', '--porcelain'])) {
  fail('working tree has uncommitted changes. Commit or discard them first.');
}

run('git', ['fetch', '--quiet', 'origin']);
const head = capture('git', ['rev-parse', 'HEAD']);
if (!capture('git', ['branch', '-r', '--contains', head])) {
  fail(`HEAD (${head.slice(0, 7)}) is not on origin. Push it first.`);
}

let releaseExists = true;
try {
  execFileSync('gh', ['release', 'view', tag], { cwd: ROOT, stdio: 'ignore' });
} catch {
  releaseExists = false;
}
if (releaseExists) {
  fail(`release ${tag} already exists. Bump the version in package.json first.`);
}

// 2. Build and pack into a fresh temp dir (npm pack also runs `prepare`)
const outDir = mkdtempSync(join(tmpdir(), 'drawlatch-release-'));
try {
  run('npm', ['pack', '--pack-destination', outDir]);
  const tarball = join(outDir, tarballName);
  const stableTarball = join(outDir, STABLE_ASSET);
  copyFileSync(tarball, stableTarball);

  // 3. Create the release with both copies attached, marked Latest
  run('gh', [
    'release',
    'create',
    tag,
    tarball,
    stableTarball,
    '--target',
    head,
    '--title',
    tag,
    '--generate-notes',
    '--latest',
  ]);

  console.log(
    `\nReleased ${tag} at ${head.slice(0, 7)} with assets ${tarballName} and ${STABLE_ASSET}`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
