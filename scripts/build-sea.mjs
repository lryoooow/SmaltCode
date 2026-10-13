/**
 * Build a single-executable `smalt.exe` (Node SEA) from the bundled CLI.
 *
 * Steps: bundle (done by the caller) → sea blob → copy node.exe → inject
 * blob with postject. Produces dist-pkg/smalt.exe — no install required.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'packages', 'cli', 'dist-bundle', 'main.cjs');
const outDir = join(root, 'dist-pkg');
const seaConfig = join(outDir, 'sea-config.json');
const seaBlob = join(outDir, 'smalt.sea');
const exe = join(outDir, process.platform === 'win32' ? 'smalt.exe' : 'smalt');
const stagedExe = join(outDir, process.platform === 'win32' ? 'smalt.building.exe' : 'smalt.building');

if (!existsSync(bundle)) {
  console.error('bundle missing — run `npm run bundle` first');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
rmSync(seaBlob, { force: true });
rmSync(stagedExe, { force: true });

writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

console.log('[sea] building blob…');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: root, stdio: 'inherit', windowsHide: true });

console.log('[sea] copying node runtime…');
copyFileSync(process.execPath, stagedExe);

console.log('[sea] injecting blob (postject)…');
execFileSync(
  process.execPath,
  ['--disable-wasm-trap-handler', '--wasm-lazy-compilation', '--liftoff-only', require.resolve('postject/dist/cli.js'), stagedExe, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
const version = execFileSync(stagedExe, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
const expectedVersion = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
if (!version.includes(expectedVersion)) throw new Error('SEA verification did not identify smalt');
renameSync(stagedExe, exe);

console.log(`[sea] done: ${exe}`);
