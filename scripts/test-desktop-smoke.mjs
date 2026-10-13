import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages/desktop');
const packaged = process.argv.includes('--packaged');
const home = join(root, '.qa-work', packaged ? 'packaged-smoke' : 'smoke-regression');
mkdirSync(home, { recursive: true });
const env = { ...process.env, SMALT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const executable = packaged ? join(appDir, 'release/win-unpacked/SmaltCode.exe') : join(root, 'node_modules/electron/dist/electron.exe');
const launch = () => spawnSync(executable, [...(packaged ? [] : [appDir]), '--smoke-test'], { env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
const html = join(appDir, 'dist/renderer/index.html');
const original = readFileSync(html, 'utf8');
const healthy = launch();
if (healthy.status !== 0) throw new Error('Healthy smoke failed: ' + healthy.stdout + healthy.stderr);
if (packaged) {
  if (!healthy.stdout.includes('[smoke] passed')) throw new Error('Packaged startup assertions did not complete');
  console.log('PASS: packaged application passed renderer, bridge, composer and kernel assertions.');
  process.exit(0);
}
try {
  writeFileSync(html, original.replace(/<script[^>]+src="\.\/main\.js"><\/script>/, ''), 'utf8');
  const broken = launch();
  if (broken.status !== 1 || !broken.stdout.includes('assertions failed')) throw new Error('Broken page was not rejected: ' + broken.status + broken.stdout + broken.stderr);
  console.log('PASS: healthy renderer exits 0; deliberately blank renderer exits 1.');
} finally { writeFileSync(html, original, 'utf8'); }
