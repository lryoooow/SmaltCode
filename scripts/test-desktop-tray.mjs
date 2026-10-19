import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const installedIndex = args.indexOf('--installed-dir');
if (installedIndex >= 0 && (!args[installedIndex + 1] || args[installedIndex + 1].startsWith('--'))) throw new Error('--installed-dir requires an installation directory');
const installed = installedIndex >= 0 ? resolve(args[installedIndex + 1]) : undefined;
const packaged = !!installed || args.includes('--packaged');
const app = join(root, 'packages/desktop');
const releaseIndex = args.indexOf('--release-dir');
if (releaseIndex >= 0 && !args[releaseIndex + 1]) throw new Error('--release-dir requires a directory');
const release = releaseIndex >= 0 ? resolve(args[releaseIndex + 1]) : join(app, 'release');
const runtime = installed ?? (packaged ? join(release, 'win-unpacked') : join(root, 'node_modules/electron/dist'));
const executable = join(runtime, packaged ? 'SmaltCode.exe' : 'electron.exe');
const home = join(root, '.qa-work', installed ? 'installed-tray' : packaged ? 'packaged-tray' : 'tray-smoke');
mkdirSync(home, { recursive: true });
const env = { ...process.env, SMALT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;

// Native startup fails before our smoke assertions when Electron data files are
// missing. Check them explicitly, then ensure quitting never changes the runtime.
for (const name of ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'locales/en-US.pak', ...(packaged ? ['resources/app.asar'] : [])]) {
  if (!existsSync(join(runtime, name))) throw new Error('Incomplete runtime: missing ' + name + ' in ' + runtime);
}
function snapshot(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return snapshot(join(directory, entry.name), relative);
    if (entry.name.endsWith('.log')) return [];
    return [[relative, createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex')]];
  });
}
const baseline = snapshot(runtime);
for (let cycle = 1; cycle <= 3; cycle++) {
  // Reuse the profile so this exercises reopening after a genuine tray quit,
  // including release of the single-instance lock, rather than three fresh users.
  const result = spawnSync(executable, [...(packaged ? [] : [app]), '--tray-smoke-test'], { cwd: runtime, env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.includes('[tray-smoke] passed')) throw new Error('Tray lifecycle cycle ' + cycle + ' failed: ' + (result.error?.message ?? result.status) + '\n' + result.stdout + result.stderr);
  for (const [name, digest] of baseline) {
    const file = join(runtime, name);
    if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) throw new Error('Runtime file changed after tray quit: ' + name);
  }
  console.log('PASS cycle ' + cycle + '/3: close hides, tray restores, explicit quit exits; ' + baseline.length + ' runtime files unchanged.');
}
