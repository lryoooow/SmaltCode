/**
 * Package the desktop app from a clean staging directory.
 *
 * electron-builder's "installing production dependencies" step corrupts the
 * shared workspace node_modules (it prunes nested deps of electron-builder
 * itself). Staging only the bundle + manifests avoids that entirely — the
 * app is fully bundled, so no node_modules are needed inside the package.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages', 'desktop');
const stage = join(appDir, '.build-stage');

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

if (existsSync(stage) && realpathSync(stage).toLowerCase() !== stage.toLowerCase()) throw new Error('Unexpected staging target');
rmSync(stage, { recursive: true, force: true });
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
execSync('npx electron-builder --win nsis', {
  cwd: stage,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});

// Publish one current installer; old build outputs must not remain beside it.
const releaseDir = join(appDir, 'release');
const installerName = 'SmaltCode-Setup-' + pkg.version + '-SFox.exe';
const stagedInstaller = join(stage, 'release', installerName);
if (!existsSync(stagedInstaller)) throw new Error('Expected installer missing: ' + installerName);
if (existsSync(releaseDir) && realpathSync(releaseDir).toLowerCase() !== releaseDir.toLowerCase()) throw new Error('Unexpected release target');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(stagedInstaller, join(releaseDir, installerName));
cpSync(join(stage, 'release', 'win-unpacked'), join(releaseDir, 'win-unpacked'), { recursive: true });
const checksum = createHash('sha256').update(readFileSync(join(releaseDir, installerName))).digest('hex');
writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), checksum + '  ' + installerName + '\n');
console.log('[desktop] installer ready: ' + installerName);
for (const [script, args] of [['test-desktop-icons.mjs', []], ['test-desktop-smoke.mjs', ['--packaged']], ['test-desktop-tray.mjs', ['--packaged']]]) {
  execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
}
