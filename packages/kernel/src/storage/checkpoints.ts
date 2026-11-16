import { mkdir, readFile, readdir, writeFile, rename, unlink, lstat, open, rm } from 'node:fs/promises';
import { linkSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { smaltHome } from '../config/settings.js';
import { isInsideWorkspace, isSensitivePath, realPathOf } from '../tools/workspace-guard.js';
import { newId, unifiedDiff } from '../util.js';

type Image = { data: string; mode: number } | null;
type Entry = { path: string; before: Image; after?: Image; restored?: boolean };
type RecordData = { id: string; threadId: string; turnId: string; operationId?: string; cwd: string; title: string; createdAt: string; complete: boolean; files: Entry[] };
export type CheckpointSummary = Omit<RecordData, 'cwd' | 'files'> & { files: Array<{ path: string; kind: 'add' | 'update' | 'delete'; restored: boolean; conflict?: string; diff?: string }> };
export type RestorePreviewRow = { path: string; status: 'ready' | 'conflict' | 'missing' | 'restored'; reason: string; version?: string; diff?: string; diffNote?: string };
export type RestoreResultRow = { path: string; status: 'restored' | 'conflict' | 'failed' | 'skipped'; reason: string };
export type RestoreResult = { restored: string[]; operationId?: string; rows: RestoreResultRow[]; notice?: string };
export type RestoreReceipt = RestoreResult & { checkpointId: string; at: string };
type ChangeItem = { turnId?: string; kind: string; path?: string };
type RestoreConfirmation = { previewPaths: string[] | null; items: ChangeItem[] };
const validId = /^[A-Za-z0-9_-]{1,160}$/;
class CheckpointScopeError extends Error {}
const hash = (image: Image | undefined) => image === null ? 'absent' : image ? createHash('sha256').update(image.data).update(String(image.mode)).digest('hex') : 'incomplete';

/** Only write/apply_patch operations are tracked. Shell side effects are never advertised as reversible. */
export class CheckpointStore {
  private chains = new Map<string, Promise<unknown>>();
  private restoring = new Set<string>();
  constructor(private readonly root = join(smaltHome(), 'checkpoints')) {}
  private file(threadId: string, id: string) {
    if (!validId.test(threadId) || !validId.test(id)) throw new Error('无效的检查点标识');
    return join(this.root, threadId, id + '.json');
  }
  private check(cwd: string, path: string) {
    if (!path || !isInsideWorkspace(cwd, path) || isSensitivePath(cwd, path)) throw new Error('检查点路径超出工作区或属于敏感路径');
    return resolve(cwd, path);
  }
  private restoreTarget(cwd: string, path: string) {
    const target = this.check(cwd, path);
    const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    if (normalize(realPathOf(target)) !== normalize(resolve(realPathOf(cwd), path))) throw new Error('路径已指向另一位置，无法安全恢复');
    return target;
  }
  private async image(cwd: string, path: string): Promise<Image> {
    const target = this.check(cwd, path);
    let stat;
    try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('检查点不支持目录、符号链接或硬链接文件');
    if (stat.size > 2 * 1024 * 1024) throw new Error('单个文件超过 2 MB 检查点上限');
    const data = await readFile(target);
    if (data.length > 2 * 1024 * 1024) throw new Error('文件在读取期间超过检查点上限');
    this.check(cwd, path);
    const after = await lstat(target);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== stat.nlink) throw new Error('文件在核对期间发生变化');
    return { data: data.toString('base64'), mode: stat.mode & 0o777 };
  }
  private async imageOptional(cwd: string, path: string): Promise<Image | 'untracked'> {
    const target = this.check(cwd, path);
    let stat;
    try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('检查点不支持目录或符号链接文件');
    if (stat.nlink > 1 || stat.size > 2 * 1024 * 1024) return 'untracked';
    const data = await readFile(target);
    if (data.length > 2 * 1024 * 1024) return 'untracked';
    this.check(cwd, path);
    const after = await lstat(target);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== stat.nlink) throw new Error('文件在核对期间发生变化');
    return { data: data.toString('base64'), mode: stat.mode & 0o777 };
  }
  private async save(record: RecordData) {
    const target = this.file(record.threadId, record.id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + '.tmp';
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, target);
  }
  async capture(threadId: string, turnId: string, cwd: string, title: string, paths: string[], operationId?: string): Promise<RecordData> {
    if (paths.length > 64) throw new Error('单次修改超过 64 个文件，请拆分操作');
    const files: Entry[] = [];
    let bytes = 0;
    for (const target of new Set(paths.map(path => relative(cwd, resolve(cwd, path)).replace(/\\/g, '/')))) {
      const before = await this.imageOptional(cwd, target);
      if (before === 'untracked') continue;
      bytes += before?.data.length ?? 0;
      if (bytes > 16 * 1024 * 1024) continue;
      files.push({ path: target, before });
    }
    const record = { id: newId('cp'), threadId, turnId, operationId, cwd, title: title.slice(0, 160), createdAt: new Date().toISOString(), complete: false, files };
    await this.save(record);
    return record;
  }
  async complete(record: RecordData) {
    const kept: Entry[] = [];
    for (const entry of record.files) {
      const after = await this.imageOptional(record.cwd, entry.path);
      if (after === 'untracked') continue;
      entry.after = after;
      if (hash(entry.before) !== hash(entry.after)) kept.push(entry);
    }
    record.files = kept;
    record.complete = true;
    if (record.files.length) await this.save(record);
    else await unlink(this.file(record.threadId, record.id)).catch(() => {});
  }
  async exclusive<T>(cwd: string, run: () => Promise<T>): Promise<T> {
    const key = realPathOf(cwd);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.chains.set(key, next);
    try { return await next; } finally { if (this.chains.get(key) === next) this.chains.delete(key); }
  }
  assertAvailable(cwd: string) {
    if ([...this.restoring].some(root => isInsideWorkspace(root, cwd) || isInsideWorkspace(cwd, root))) throw new Error('工作区正在恢复检查点，请稍后再执行');
  }
  private async load(threadId: string, id: string, cwd: string): Promise<RecordData> {
    const record = JSON.parse(await readFile(this.file(threadId, id), 'utf8')) as RecordData;
    if (record.threadId !== threadId || record.id !== id || typeof record.cwd !== 'string' || !Array.isArray(record.files)) throw new Error('无效的检查点记录');
    if (realPathOf(record.cwd) !== realPathOf(cwd)) throw new CheckpointScopeError('检查点与当前工作区不匹配');
    for (const file of record.files) {
      if (typeof file.path !== 'string') throw new Error('无效的检查点路径');
      const rel = relative(cwd, resolve(cwd, file.path));
      if (!rel || isAbsolute(rel) || /^\.\.(?:[\\/]|$)/.test(rel)) throw new Error('检查点路径超出工作区');
    }
    return record;
  }
  private async previewFile(record: RecordData, file: Entry, withDiff: boolean): Promise<RestorePreviewRow> {
    const path = file.path;
    if (!record.complete || file.after === undefined || file.before === undefined) return { path, status: 'missing', reason: '此文件缺少完整的修改前后快照' };
    if (file.restored) return { path, status: 'restored', reason: '此检查点已恢复过该文件' };
    try {
      const target = this.restoreTarget(record.cwd, path);
      const current = await this.image(record.cwd, path);
      if (current === null && file.after === null && file.before) {
        const parent = await lstat(dirname(target)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        if (!parent?.isDirectory()) return { path, status: 'conflict', reason: '原目录已不存在，已保留当前目录结构' };
      }
      const matches = hash(current) === hash(file.after);
      const row: RestorePreviewRow = matches ? {
        path, status: 'ready', version: hash(file.before) + ':' + hash(file.after),
        reason: file.before === null ? '移除本次新建的文件' : current === null ? '重新创建本次删除的文件' : '写回修改前的内容',
      } : { path, status: 'conflict', reason: '当前文件与修改后快照不同，可能已有后续修改' };
      if (withDiff) {
        const decode = (value: Image) => value ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.data, 'base64')) : '';
        try {
          const before = decode(current), after = decode(file.before);
          if (before.includes('\0') || after.includes('\0')) throw new Error();
          const diff = unifiedDiff(path, before.split('\n'), after.split('\n'));
          row.diff = diff.slice(0, 64000);
          if (!diff || diff.length > 64000) row.diffNote = diff ? '文本差异仅展示前 64,000 字符。' : '文本内容相同，文件存在状态或权限可能不同。';
        } catch { row.diffNote = '二进制文件或非 UTF-8 文本，无法展示文本差异。'; }
      }
      return row;
    } catch (error) { return { path, status: 'conflict', reason: error instanceof Error ? error.message : String(error) }; }
  }
  async preview(threadId: string, id: string, cwd: string, items: ChangeItem[], paths?: string[], diffPath?: string) {
    return { rows: await this.previewRows(await this.load(threadId, id, cwd), items, paths, diffPath) };
  }
  private async previewRows(record: RecordData, items: ChangeItem[], paths?: string[], diffPath?: string, excluded?: Set<string>) {
    const { cwd } = record;
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || !record.files.some(file => file.path === path)))) throw new Error('无效的恢复预览范围');
    const rows: RestorePreviewRow[] = [];
    for (const file of record.files) if ((!paths || paths.includes(file.path)) && (!diffPath || diffPath === file.path) && !excluded?.has(file.path)) rows.push(await this.previewFile(record, file, !!diffPath));
    if (!diffPath) {
      const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
      const recorded = new Set(record.files.map(file => key(file.path)));
      for (const item of items) {
        if (item.turnId !== record.turnId || item.kind !== 'fileChange' || !item.path) continue;
        const path = relative(cwd, resolve(cwd, item.path)).replace(/\\/g, '/');
        if (!path || isAbsolute(path) || /^\.\.(?:\/|$)/.test(path) || recorded.has(key(path))) continue;
        recorded.add(key(path));
        rows.push({ path, status: 'missing', reason: '本轮有变更记录，此检查点没有该文件的恢复快照' });
      }
    }
    return rows;
  }
  private receiptPath(threadId: string) { return join(dirname(this.file(threadId, 'index')), 'latest-restore.receipt'); }
  async latestRestore(threadId: string, cwd: string): Promise<RestoreReceipt | undefined> {
    try {
      const { workspace, receipt } = JSON.parse(await readFile(this.receiptPath(threadId), 'utf8')) as { workspace: string; receipt: RestoreReceipt };
      if (workspace !== realPathOf(cwd) || typeof receipt?.checkpointId !== 'string' || !validId.test(receipt.checkpointId) || typeof receipt.at !== 'string' || !Number.isFinite(Date.parse(receipt.at))) return;
      if (!Array.isArray(receipt.restored) || !receipt.restored.every(path => typeof path === 'string') || !Array.isArray(receipt.rows)) return;
      if (receipt.rows.every(row => row && typeof row.path === 'string' && typeof row.reason === 'string' && ['restored', 'skipped', 'conflict', 'failed'].includes(row.status))) return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[checkpoint] skipped unreadable restore receipt');
    }
  }
  private async saveRestore(threadId: string, cwd: string, receipt: RestoreReceipt) {
    const target = this.receiptPath(threadId);
    const temporary = target + '.' + newId('restore') + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ workspace: realPathOf(cwd), receipt }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async delete(threadId: string): Promise<void> {
    const dir = dirname(this.file(threadId, 'index'));
    let info;
    try { info = await lstat(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || !isInsideWorkspace(this.root, dir) || resolve(dir) === resolve(this.root)) throw new Error('无效的检查点目录');
    await rm(dir, { recursive: true, force: true });
  }
  async list(threadId: string, cwd: string, detailId?: string): Promise<CheckpointSummary[]> {
    const dir = dirname(this.file(threadId, 'index'));
    let names: string[];
    try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: CheckpointSummary[] = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const id = name.slice(0, -5);
      if (detailId && detailId !== id) continue;
      let record: RecordData;
      try { record = await this.load(threadId, id, cwd); }
      catch (error) { if (detailId || error instanceof CheckpointScopeError) throw error; console.warn('[checkpoint] skipped unreadable record: ' + id); continue; }
      const files: CheckpointSummary['files'] = [];
      for (const entry of record.files) {
        let conflict: string | undefined;
        if (!record.complete || entry.after === undefined) conflict = '修改记录尚未完整，无法恢复';
        else if (!entry.restored) {
          try { if (hash(await this.image(cwd, entry.path)) !== hash(entry.after)) conflict = '文件已被后续操作或手动修改，请先处理差异'; }
          catch (error) { conflict = error instanceof Error ? error.message : String(error); }
        }
        const text = (image: Image | undefined) => image ? Buffer.from(image.data, 'base64').toString('utf8') : '';
        files.push({ path: entry.path, kind: entry.before === null ? 'add' : entry.after === null ? 'delete' : 'update', restored: !!entry.restored, conflict,
          ...(detailId ? { diff: unifiedDiff(entry.path, text(entry.before).split('\n'), text(entry.after).split('\n')).slice(0, 64000) } : {}) });
      }
      const { cwd: _cwd, files: _files, ...summary } = record;
      result.push({ ...summary, files });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async restore(threadId: string, id: string, cwd: string, paths: string[] | undefined, assertIdle: () => void, versions?: Record<string, string>, confirmation?: RestoreConfirmation): Promise<RestoreReceipt> {
    this.assertAvailable(cwd);
    this.restoring.add(cwd);
    try { return await this.exclusive(cwd, async () => {
      assertIdle();
      const record = await this.load(threadId, id, cwd);
      if (!record.complete) throw new Error('检查点记录尚未完整，无法恢复');
      if (paths && (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !record.files.some(file => file.path === path)))) throw new Error('恢复列表包含未记录的文件');
      const selected = record.files.filter(file => (versions || !file.restored) && (!paths || paths.includes(file.path)));
      if (!selected.length) throw new Error('没有可恢复的文件');
      // Validate the entire selection before touching any file.
      if (!versions) for (const file of selected) if (hash(await this.image(cwd, file.path)) !== hash(file.after)) throw new Error('恢复冲突：' + file.path + ' 已被后续操作或手动修改');
      const scope = confirmation?.previewPaths ?? undefined;
      if (scope && (!Array.isArray(scope) || selected.some(file => !scope.includes(file.path)))) throw new Error('恢复文件不在预览范围内');
      const skipped = confirmation ? await this.previewRows(record, confirmation.items, scope, undefined, new Set(selected.map(file => file.path))) : [];
      const rows: RestoreResultRow[] = [], restored: string[] = [];
      for (const file of selected) {
        const preview = await this.previewFile(record, file, false);
        if (preview.status !== 'ready' || versions && (!Object.hasOwn(versions, file.path) || versions[file.path] !== preview.version)) {
          const reason = preview.status === 'ready' ? '检查点版本已变化，请重新预览' : preview.reason;
          if (!versions && !restored.length) throw new Error('恢复冲突：' + file.path + ' · ' + reason);
          rows.push({ path: file.path, status: preview.status === 'restored' || preview.status === 'missing' ? 'skipped' : 'conflict', reason });
          continue;
        }
        let temporary: string | undefined, changed = false;
        try {
          assertIdle();
          const target = this.restoreTarget(cwd, file.path);
          if (file.before) {
            const candidate = join(dirname(target), '.' + newId('restore') + '.tmp');
            const handle = await open(candidate, 'wx', 0o600);
            temporary = candidate;
            try { await handle.writeFile(Buffer.from(file.before.data, 'base64')); await handle.chmod(file.before.mode); }
            finally { await handle.close(); }
          }
          for (let attempt = 0; ; attempt++) {
            const current = await this.image(cwd, file.path);
            if (hash(current) !== hash(file.after)) break;
            assertIdle();
            this.restoreTarget(cwd, file.path);
            try {
              if (!temporary) unlinkSync(target);
              else if (current === null) linkSync(temporary, target);
              else { renameSync(temporary, target); temporary = undefined; }
              changed = true;
              break;
            } catch (error) {
              // Windows scanners or preview readers can briefly hold a file open.
              const code = (error as NodeJS.ErrnoException).code;
              if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
              await delay(30 * (attempt + 1));
            }
          }
          if (!changed) {
            rows.push({ path: file.path, status: 'conflict', reason: '确认后文件发生变化，已保留当前版本' });
            continue;
          }
          restored.push(file.path);
          file.restored = true;
          await this.save(record);
          rows.push({ path: file.path, status: 'restored', reason: preview.reason + '，已完成' });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!versions && !restored.length) throw error;
          rows.push({ path: file.path, status: changed ? 'restored' : 'failed', reason: changed ? '文件已恢复，检查点记录保存失败：' + reason : reason });
        } finally {
          if (temporary) await unlink(temporary).catch(() => {});
        }
      }
      for (const row of skipped) rows.push({ path: row.path, status: 'skipped', reason: row.status === 'ready' ? '未列入本次确认范围' : row.reason });
      const receipt: RestoreReceipt = { checkpointId: id, at: new Date().toISOString(), restored, operationId: record.operationId, rows };
      try { await this.saveRestore(threadId, cwd, receipt); }
      catch { receipt.notice = '本次恢复结果未能保存，关闭窗口前可在此核对。'; }
      return receipt;
    }); } finally { this.restoring.delete(cwd); }
  }
}
