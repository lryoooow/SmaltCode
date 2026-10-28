import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function nonSystemDrives(drives: string[], systemDrive: string): string[] {
  const system = systemDrive.slice(0, 2).toUpperCase();
  return [...new Set(drives.map(value => value.toUpperCase()).filter(value => /^[A-Z]:\\?$/.test(value) && value.slice(0, 2) !== system).map(value => value.slice(0, 2) + '\\'))].sort((a, b) => Number(b === 'D:\\') - Number(a === 'D:\\') || a.localeCompare(b));
}

function digestTree(directory: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  const walk = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), key = relative ? relative + '/' + name : name, info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('原数据包含目录链接，未自动迁移；原数据保持原样');
      if (info.isDirectory()) { files[key + '/'] = ''; walk(path, key); }
      else if (info.isFile()) {
        const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(path, 'r');
        try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
        finally { closeSync(fd); }
        files[key] = hash.digest('hex');
      } else throw new Error('原数据包含特殊文件，未自动迁移；原数据保持原样');
    }
  };
  walk(directory, ''); return files;
}

/** Copy/verify/publish. Existing source and destination are never overwritten. */
export function copyLocalData(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error('目标已有数据，未合并或覆盖');
  const before = digestTree(source), temporary = destination + '.import-' + randomUUID();
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true, dereference: false });
  if (JSON.stringify(before) !== JSON.stringify(digestTree(temporary)) || JSON.stringify(before) !== JSON.stringify(digestTree(source))) throw new Error('本地数据校验未通过，原数据保留，未切换存储位置');
  renameSync(temporary, destination);
}

export function configureDesktopStorage(options: { appData: string; userHome: string; explicitHome?: string; platform?: NodeJS.Platform; systemDrive?: string; drives?: () => string[]; directory?: (drive: string) => string }): string {
  if (options.explicitHome) return resolve(options.explicitHome);
  if ((options.platform ?? process.platform) !== 'win32') return join(options.userHome, '.smalt');
  const system = options.systemDrive ?? process.env.SystemDrive ?? 'C:', pointer = join(options.appData, 'SmaltCode', 'storage-location.json');
  const valid = (path: string) => /^[A-Z]:\\/i.test(path) && win32.parse(path).root.slice(0, 2).toUpperCase() !== system.slice(0, 2).toUpperCase();
  if (existsSync(pointer)) {
    const saved = JSON.parse(readFileSync(pointer, 'utf8'));
    if (saved?.version !== 1 || typeof saved.home !== 'string' || !valid(saved.home) || !existsSync(saved.home) || !valid(realpathSync(saved.home))) throw new Error('本地存储位置不可用，请恢复非系统盘后重试；未改用系统盘或创建空历史');
    return saved.home;
  }
  const drives = nonSystemDrives((options.drives ?? (() => {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 12000, encoding: 'utf8' });
    const values = JSON.parse(text); return Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
  }))(), system);
  let chosen: string | undefined;
  for (const drive of drives) {
    const directory = options.directory?.(drive) ?? join(drive, 'SmaltCode');
    try { mkdirSync(directory, { recursive: true }); if (valid(realpathSync(directory))) { chosen = join(directory, 'Data'); break; } } catch { /* try another fixed local disk */ }
  }
  if (!chosen) throw new Error('未找到可写的非系统本地磁盘。请连接本地数据盘后重试；不会自动保存到系统盘或云端。');
  const legacy = join(options.userHome, '.smalt');
  if (existsSync(chosen)) throw new Error('发现未登记的本地数据目录，未覆盖；请核对存储配置');
  if (existsSync(legacy)) copyLocalData(legacy, chosen); else mkdirSync(chosen, { recursive: true });
  mkdirSync(dirname(pointer), { recursive: true });
  const temporary = pointer + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify({ version: 1, home: chosen, original: existsSync(legacy) ? legacy : undefined, createdAt: new Date().toISOString() }), { mode: 0o600 });
  renameSync(temporary, pointer); return chosen;
}
