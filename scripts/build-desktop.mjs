/**
 * Package the desktop app from a clean staging directory.
 *
 * electron-builder's "installing production dependencies" step corrupts the
 * shared workspace node_modules (it prunes nested deps of electron-builder
 * itself). Staging only the bundle + manifests avoids that entirely — the
 * app is fully bundled, so no node_modules are needed inside the package.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages', 'desktop');
const stage = join(appDir, '.build-stage');
const releaseDir = join(appDir, 'release');
const require = createRequire(import.meta.url);
// Resolve local tools up front: never let npx fetch a different builder.
const builderCLI = require.resolve('electron-builder/cli.js');
require.resolve('resedit');
function assertBuildDirectory(target) {
  const absolute = resolve(target);
  if (![stage, releaseDir].some(allowed => absolute.toLowerCase() === resolve(allowed).toLowerCase())) throw new Error('Unexpected build directory: ' + absolute);
  if (dirname(absolute).toLowerCase() !== realpathSync(appDir).toLowerCase()) throw new Error('Build directory escaped desktop workspace');
  if (existsSync(absolute) && realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new Error('Build directory is redirected: ' + absolute);
}
assertBuildDirectory(stage);
assertBuildDirectory(releaseDir);

// Package only a freshly checked renderer, with asserted startup.
execSync('npm run typecheck', { cwd: root, stdio: 'inherit' });
execSync('npm run -w @smalt/desktop bundle', { cwd: root, stdio: 'inherit' });
const smokeHome = join(root, '.qa-work', 'package-smoke');
mkdirSync(smokeHome, { recursive: true });
const smokeEnv = { ...process.env, SMALT_HOME: smokeHome };
delete smokeEnv.ELECTRON_RUN_AS_NODE;
execFileSync(process.execPath, [join(root, 'node_modules/electron/install.js')], { cwd: root, stdio: 'inherit', windowsHide: true });
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
execFileSync(electron, [appDir, '--smoke-test'], {
  cwd: root, stdio: 'inherit', timeout: 25_000,
  env: smokeEnv,
  windowsHide: true,
});

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
if (pkg.version !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) throw new Error('Desktop/root version mismatch');

assertBuildDirectory(stage);
rmSync(stage, { recursive: true, force: true });
let retainStageForRecovery = false;
try {
mkdirSync(join(stage, 'dist'), { recursive: true });
cpSync(join(appDir, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(appDir, 'electron-builder.yml'), join(stage, 'electron-builder.yml'));
cpSync(join(appDir, 'after-pack.cjs'), join(stage, 'after-pack.cjs'));
cpSync(join(appDir, 'assets'), join(stage, 'assets'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
cpSync(join(root, 'NOTICE'), join(stage, 'NOTICE'));

writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'smaltcode-desktop',
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      license: 'Apache-2.0',
      main: 'dist/main/index.js',
      // pinned so electron-builder can compute the runtime version without
      // needing an installed electron module in the staging dir
      devDependencies: { electron: pkg.devDependencies.electron },
    },
    null,
    2,
  ) + '\n',
);

console.log('[desktop] staging complete, building nsis installer…');
execFileSync(process.execPath, [builderCLI, '--win', 'nsis'], {
  cwd: stage,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});

// Verify the candidate before replacing the previous local installer.
const installerName = 'SmaltCode-Setup-' + pkg.version + '-SFox.exe';
const stagedInstaller = join(stage, 'release', installerName);
if (!existsSync(stagedInstaller)) throw new Error('Expected installer missing: ' + installerName);
const candidate = join(stage, 'verified-release');
mkdirSync(candidate);
cpSync(stagedInstaller, join(candidate, installerName));
renameSync(join(stage, 'release', 'win-unpacked'), join(candidate, 'win-unpacked'));
const checksum = createHash('sha256').update(readFileSync(join(candidate, installerName))).digest('hex');
writeFileSync(join(candidate, 'SHA256SUMS.txt'), checksum + '  ' + installerName + '\n');
for (const [script, args] of [['test-desktop-icons.mjs', []], ['test-desktop-package.mjs', []], ['test-desktop-runtime.mjs', []], ['test-desktop-smoke.mjs', ['--packaged']], ['test-desktop-tray.mjs', ['--packaged']]]) {
  execFileSync(process.execPath, [join(root, 'scripts', script), ...args, '--release-dir', candidate], { cwd: root, stdio: 'inherit', windowsHide: true });
}
assertBuildDirectory(releaseDir);
const previous = join(stage, 'previous-release');
if (existsSync(releaseDir)) renameSync(releaseDir, previous);
try { renameSync(candidate, releaseDir); }
catch (error) {
  if (existsSync(previous)) {
    try { renameSync(previous, releaseDir); }
    catch (rollbackError) { retainStageForRecovery = true; throw new AggregateError([error, rollbackError], 'Previous release retained at ' + previous); }
  }
  throw error;
}
console.log('[desktop] installer ready: ' + join(releaseDir, installerName));
console.log('[desktop] SHA256: ' + checksum);
} finally {
  if (!retainStageForRecovery) { assertBuildDirectory(stage); rmSync(stage, { recursive: true, force: true }); }
}
