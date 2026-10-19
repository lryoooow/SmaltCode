/** Local source preview only. Never builds an installer or uses the release profile. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(root, '.local-preview', 'data');
const desktop = join(root, 'packages', 'desktop');
const executable = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
if (!existsSync(executable)) {
  console.error('缺少开发依赖，请先在仓库目录运行 npm ci。'); process.exit(1);
}
if (!process.argv.includes('--no-build')) {
  const build = spawnSync(process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/c', 'npm run build'] : ['run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.error || build.status !== 0) { console.error('本地源码构建失败，未启动预览。', build.error?.message ?? ''); process.exit(1); }
}
mkdirSync(home, { recursive: true });
const log = openSync(join(home, 'preview-launch.log'), 'a');
const env = { ...process.env, SMALT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [desktop, '--development-preview'], { cwd: desktop, env, detached: true, stdio: ['ignore', log, log], windowsHide: false });
child.once('error', error => { console.error('预览启动失败：' + error.message); process.exitCode = 1; });
child.once('spawn', () => { console.log('SmaltCode 开发预览已启动。\n独立数据目录：' + home + '\n首次使用请在设置中配置模型。关闭窗口会驻留托盘，右键托盘退出。'); });
child.unref(); closeSync(log);
