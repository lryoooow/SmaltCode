/** Local Mac distribution only. No CI, cross-signing, or unsigned release fallback. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validateMacBuild } from './macos-build-policy.mjs';

const arch = validateMacBuild({ platform: process.platform, arch: process.arch, targetArch: process.argv[2] ?? process.arch, env: process.env });
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const desktop = join(root, 'packages/desktop'), require = createRequire(import.meta.url);
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, stdio: 'inherit', timeout: 120_000, ...options });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
// Check installed tools and notarization credentials without exposing their values.
run('/usr/bin/xcrun', ['--find', 'notarytool']);
run('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : []), '--output-format', 'json'], { env, stdio: 'pipe' });
run('npm', ['run', 'typecheck']);
run('npm', ['run', '-w', '@smalt/desktop', 'bundle']);
const scratch = join(root, '.qa-work'); mkdirSync(scratch, { recursive: true });
const stage = mkdtempSync(join(scratch, 'mac-package-'));
if (dirname(realpathSync(stage)) !== realpathSync(scratch)) throw new Error('Invalid Mac build staging directory');
// Candidates are retained on failure. Previous Windows/Mac artifacts are never removed.
for (const file of ['dist', 'assets', 'build', 'electron-builder.yml', 'electron-builder.mac.yml', 'after-pack-mac.cjs']) cpSync(join(desktop, file), join(stage, file), { recursive: true, verbatimSymlinks: true });
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
if (pkg.version !== JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) throw new Error('Desktop/root version mismatch');
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'smaltcode-desktop', version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, main: pkg.main, devDependencies: { electron: pkg.devDependencies.electron } }, null, 2));
for (const file of ['LICENSE', 'NOTICE']) cpSync(join(root, file), join(stage, file));
// The shared bundle can contain another OS from a previous development run.
const native = join(stage, 'dist/main/native/node-pty/prebuilds');
if (readdirSync(native).length !== 1 || !existsSync(join(native, 'darwin-' + arch))) throw new Error('请在干净的 Mac 检出中构建；PTY 包含其他平台的资源。');
run(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.mac.yml', '--mac', 'dmg', 'zip', '--' + arch, '--publish', 'never'], { cwd: stage, env, timeout: 1_800_000 });
const output = join(stage, 'release-mac');
const appFolder = readdirSync(output).find(name => name === (arch === 'arm64' ? 'mac-arm64' : 'mac'));
if (!appFolder) throw new Error('Missing packaged Mac application');
const app = join(output, appFolder, 'SmaltCode.app'), binary = join(app, 'Contents/MacOS/SmaltCode');
const plist = require('plist');
const info = plist.parse(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'));
if (info.CFBundleIdentifier !== 'app.smaltcode.desktop' || info.CFBundleShortVersionString !== pkg.version || info.LSMinimumSystemVersion !== '13.0') throw new Error('Mac bundle identity, version or minimum system mismatch');
if (!info.CFBundleIconFile || !readFileSync(join(app, 'Contents/Resources', info.CFBundleIconFile)).equals(readFileSync(join(stage, 'assets/smalt.icns')))) throw new Error('Mac bundle did not receive the canonical S Fox icon');
run('/usr/bin/lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', binary]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
run('/usr/bin/xcrun', ['stapler', 'validate', app]);
for (const flag of ['--smoke-test', '--tray-smoke-test']) {
  const home = mkdtempSync(join(stage, 'app-test-'));
  run(binary, [flag], { env: { ...env, SMALT_HOME: home }, timeout: 45_000 });
}
// Real native PTY ABI/input/isolation/exit checks run using the shipped Electron.
run(binary, [join(root, 'scripts/test-macos-pty.cjs'), join(app, 'Contents/Resources/app.asar.unpacked/dist/main/native/node-pty'), stage], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 45_000 });
const artifacts = readdirSync(output).filter(name => /\.(dmg|zip)$/.test(name));
if (artifacts.length !== 2) throw new Error('Expected one DMG and one ZIP');
// Verify the archive users will actually extract, including signature/stapled ticket.
const extracted = join(stage, 'zip-acceptance'); mkdirSync(extracted);
run('/usr/bin/ditto', ['-x', '-k', join(output, artifacts.find(name => name.endsWith('.zip'))), extracted]);
const zipApp = join(extracted, 'SmaltCode.app');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', zipApp]);
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', zipApp]);
run('/usr/bin/xcrun', ['stapler', 'validate', zipApp]);
for (const name of artifacts.filter(name => name.endsWith('.dmg'))) {
  const file = join(output, name);
  run('/usr/bin/codesign', ['--verify', '--strict', file]);
  const result = run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : []), '--wait', '--output-format', 'json'], { env, stdio: 'pipe', timeout: 1_800_000 });
  if (JSON.parse(result.toString('utf8')).status !== 'Accepted') throw new Error('Apple did not accept the DMG; candidate retained for inspection');
  run('/usr/bin/xcrun', ['stapler', 'staple', file]);
  run('/usr/bin/xcrun', ['stapler', 'validate', file]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', file]);
}
writeFileSync(join(output, 'SHA256SUMS.txt'), artifacts.map(name => createHash('sha256').update(readFileSync(join(output, name))).digest('hex') + '  ' + name).join('\n') + '\n');
writeFileSync(join(output, 'verification.json'), JSON.stringify({ version: pkg.version, arch, time: new Date().toISOString(), automaticChecks: ['Developer ID signature', 'Gatekeeper app and DMG', 'Apple notarization and stapling', 'native architecture', 'startup', 'resident close and explicit quit', 'PTY ABI/input/session isolation/exit'], manualAcceptance: 'pending: Dock/menu/icon, dialogs, SSH reconnect, Office capability, descendant cleanup, clean Mac installation' }, null, 2));
// Use a fresh destination; never overwrite the last candidate or a published release.
const destination = resolve(desktop, 'release-mac', `${pkg.version}-${arch}-${Date.now()}`);
mkdirSync(dirname(destination), { recursive: true });
if (realpathSync(dirname(destination)) !== join(realpathSync(desktop), 'release-mac')) throw new Error('Mac output directory is redirected');
renameSync(output, destination);
console.log('macOS 候选包通过自动检查，仍需真实界面和跨功能验收后发布：' + destination);
