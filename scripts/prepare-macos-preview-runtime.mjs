import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

/** Ad-hoc local development bundle. Never used by the signed release command. */
export async function prepareMacPreviewRuntime(root) {
  if (process.platform !== 'darwin') throw new Error('Mac preview requires macOS');
  const desktop = join(root, 'packages/desktop');
  const parent = join(root, '.local-preview', 'runtime'); mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, 'mac-preview-'));
  if (dirname(realpathSync(stage)) !== realpathSync(parent)) throw new Error('Preview staging escaped its directory');
  for (const name of ['dist', 'assets', 'build', 'after-pack-mac.cjs']) cpSync(join(desktop, name), join(stage, name), { recursive: true, verbatimSymlinks: true });
  for (const name of ['LICENSE', 'NOTICE']) cpSync(join(root, name), join(stage, name));
  const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'smaltcode-preview', version: pkg.version, main: pkg.main, author: pkg.author, license: pkg.license, devDependencies: { electron: pkg.devDependencies.electron } }));
  const config = {
    appId: 'app.smaltcode.preview', productName: 'SmaltCode Preview',
    electronDist: join(root, 'node_modules/electron/dist'),
    directories: { output: 'output' },
    afterPack: './after-pack-mac.cjs', forceCodeSigning: false,
    files: ['dist/**/*', 'package.json', 'LICENSE', 'NOTICE'],
    asarUnpack: ['dist/main/native/**/*', 'dist/main/*worker.cjs', 'dist/main/*.py', 'dist/main/*.ps1', 'dist/main/pdf-assets/**/*'],
    mac: { icon: 'assets/smalt.icns', identity: null, notarize: false, minimumSystemVersion: '13.0', target: 'dir' },
  };
  writeFileSync(join(stage, 'preview-config.json'), JSON.stringify(config));
  const require = createRequire(import.meta.url), env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'preview-config.json', '--mac', 'dir', '--' + process.arch, '--publish', 'never'], { cwd: stage, env, stdio: 'inherit', timeout: 180_000 });
  const bundle = join(stage, 'output', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'SmaltCode Preview.app');
  // Required for a modified Apple Silicon application to launch. This is a local
  // ad-hoc identity, not Developer ID or Apple notarization.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit', timeout: 60_000 });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit', timeout: 60_000 });
  const executable = join(bundle, 'Contents/MacOS/SmaltCode Preview');
  if (!existsSync(executable)) throw new Error('Branded Mac preview executable is missing');
  return { executable, runtime: bundle, sourceExecutable: executable, reused: false, branded: true, packaged: true };
}
