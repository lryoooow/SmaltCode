/**
 * Stage a self-contained npm package for `smalt` and pack it.
 *
 * The bundle inlines @smalt/kernel, so the published tarball has no
 * dependencies — installable offline with `npm i -g smalt-<ver>.tgz`.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const stage = join(here, '.pack-stage');
const outDir = join(root, 'dist-pkg');

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
if (!existsSync(join(here, 'dist-bundle', 'main.cjs'))) {
  console.error('dist-bundle/main.cjs missing — run `npm run -w @smalt/cli bundle` first');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist-bundle'), { recursive: true });
cpSync(join(here, 'dist-bundle'), join(stage, 'dist-bundle'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
cpSync(join(root, 'NOTICE'), join(stage, 'NOTICE'));
cpSync(join(root, 'README.md'), join(stage, 'README.md'));

const manifest = {
  name: 'smalt',
  version: pkg.version,
  description: pkg.description,
  license: 'Apache-2.0',
  type: 'commonjs',
  bin: { smalt: 'dist-bundle/main.cjs' },
  main: 'dist-bundle/main.cjs',
  files: ['dist-bundle'],
  engines: { node: '>=22' },
  keywords: ['ai', 'agent', 'coding-agent', 'cli', 'llm'],
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

mkdirSync(outDir, { recursive: true });
execSync('npm pack --pack-destination', { cwd: stage, stdio: 'inherit' });
// npm pack writes smalt-<version>.tgz into cwd; move it to dist-pkg
const tgz = `smalt-${pkg.version}.tgz`;
cpSync(join(stage, tgz), join(outDir, tgz), { force: true });
rmSync(join(stage, tgz), { force: true });
console.log(`packed: ${join(outDir, tgz)}`);
