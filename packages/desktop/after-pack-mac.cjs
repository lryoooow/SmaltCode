const { chmodSync, existsSync, readdirSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async context => {
  if (process.platform !== 'darwin' || context.electronPlatformName !== 'darwin') throw new Error('macOS packaging must run on a Mac');
  const native = join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents/Resources/app.asar.unpacked/dist/main/native');
  const prebuilds = join(native, 'node-pty/prebuilds');
  const expected = 'darwin-' + process.arch;
  if (!existsSync(join(prebuilds, expected, 'pty.node'))) throw new Error('Missing native Mac PTY');
  if (readdirSync(prebuilds).some(name => name !== expected)) throw new Error('Native runtime contains a different platform/architecture');
  const helper = join(prebuilds, expected, 'spawn-helper');
  if (!statSync(helper).isFile()) throw new Error('Missing PTY spawn helper');
  chmodSync(helper, 0o755);
  // A previous Windows bundle may leave its supervisor in the shared dist tree.
  // Remove only that exact file from this private packaged candidate, before signing.
  const windowsSupervisor = join(native, 'SmaltProcessSupervisor.exe');
  if (existsSync(windowsSupervisor)) rmSync(windowsSupervisor);
};
