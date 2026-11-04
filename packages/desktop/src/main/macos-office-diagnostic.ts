import { execFile } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { MacOfficeDiagnostic } from '../shared/office.js';

type SystemTool = '/usr/bin/plutil' | '/usr/bin/codesign' | '/usr/sbin/spctl';
type Options = { platform?: string; signal?: AbortSignal; run?: (tool: SystemTool, args: string[], signal?: AbortSignal) => Promise<string> };
function run(tool: SystemTool, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((accept, reject) => execFile(tool, args, { timeout: 15_000, maxBuffer: 32 * 1024, signal, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } }, (error, stdout) => error ? reject(Error('系统核验未通过')) : accept(stdout.trim())));
}

/** Read-only diagnosis of a user-selected application. Never executes Office or
 * Python, edits a signed bundle, persists an engine, or grants document access. */
export async function diagnoseMacOffice(application: string, options: Options = {}): Promise<MacOfficeDiagnostic> {
  if ((options.platform ?? process.platform) !== 'darwin') throw Error('此检测仅适用于 macOS');
  if (!isAbsolute(application) || !basename(application).endsWith('.app') || !(await lstat(application)).isDirectory() || (await lstat(application)).isSymbolicLink()) throw Error('请选择本机 LibreOffice.app 应用包');
  const root = await realpath(application), checks: MacOfficeDiagnostic['checks'] = [];
  const cancelled = () => { if (options.signal?.aborted) throw Error('已取消 Office 检测'); };
  const file = async (parts: string[]) => {
    try {
      const path = await realpath(join(root, ...parts)), leaf = relative(root, path);
      if (leaf.startsWith('..') || isAbsolute(leaf) || !(await stat(path)).isFile()) return;
      return path;
    } catch { return; }
  };
  cancelled();
  const info = await file(['Contents', 'Info.plist']), executable = await file(['Contents', 'MacOS', 'soffice']);
  if (!info || !executable) throw Error('应用包结构不完整，或程序指向包外位置');
  const system = options.run ?? run;
  let identity = false;
  try { identity = (await system('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', info], options.signal)).trim() === 'soffice'; } catch {}
  cancelled(); checks.push({ id: 'identity', label: '应用标识', passed: identity, detail: identity ? '应用声明使用 soffice 主程序' : '应用标识未能确认' });
  if (identity) {
    for (const [tool, args, id, label] of [
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', root], 'signature', '签名完整性'],
      ['/usr/sbin/spctl', ['--assess', '--type', 'execute', root], 'gatekeeper', 'Gatekeeper 核验'],
    ] as const) {
      let passed = false;
      try { await system(tool, [...args], options.signal); passed = true; } catch {}
      cancelled(); checks.push({ id, label, passed, detail: passed ? '本机系统检查通过' : '本机系统未确认通过；不会绕过安全策略' });
    }
  }
  let pythonFound = false;
  for (const parts of [
    ['Contents', 'Resources', 'python'],
    ['Contents', 'Resources', 'python', 'bin', 'python3'],
    ['Contents', 'Frameworks', 'LibreOfficePython.framework', 'Versions', 'Current', 'bin', 'python3'],
  ]) if (await file(parts)) { pythonFound = true; break; }
  cancelled(); checks.push({ id: 'python', label: 'Python 入口', passed: pythonFound, detail: pythonFound ? '发现包内入口；尚未运行，不能确认 UNO 可用' : '未发现已识别的包内 Python 入口；不会使用系统 Python 代替' });
  checks.push({ id: 'roundtrip', label: '编辑与保存验证', passed: false, detail: '待真实 Mac 验证 UNO、独立进程、保存回执与重开；本次不启动引擎或修改原件' });
  return { application: root, ready: false, checks };
}
