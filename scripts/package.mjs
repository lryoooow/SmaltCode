/**
 * Full packaging pipeline:
 *   1. bundle the CLI (self-contained)
 *   2. npm tarball
 *   3. SEA single-file exe
 *   4. post-packaging SECURITY tests against the produced exe (must pass)
 */

import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, opts = {}) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

run('npm run -w @smalt/kernel build');
run('npm run -w @smalt/cli build');
run('npm run -w @smalt/cli bundle');
run('npm run -w @smalt/cli pack:tgz');
run('node scripts/build-sea.mjs');

console.log('\n▶ post-packaging security tests (against dist-pkg/smalt.exe)');
run('npx vitest run packages/cli/test/exe-security.test.ts');

console.log('\n✔ packaging complete:');
console.log('  dist-pkg/smalt-0.0.1.tgz');
console.log('  dist-pkg/smalt.exe');
