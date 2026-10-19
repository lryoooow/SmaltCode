import { mkdir, readFile, readdir, writeFile, rename, unlink, lstat, chmod, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { smaltHome } from '../config/settings.js';
import { isInsideWorkspace, isSensitivePath, realPathOf } from '../tools/workspace-guard.js';
import { newId, unifiedDiff } from '../util.js';

type Image = { data: string; mode: number } | null;
type Entry = { path: string; before: Image; after?: Image; restored?: boolean };
type RecordData = { id: string; threadId: string; turnId: string; operationId?: string; cwd: string; title: string; createdAt: string; complete: boolean; files: Entry[] };
export type CheckpointSummary = Omit<RecordData, 'cwd' | 'files'> & { files: Array<{ path: string; kind: 'add' | 'update' | 'delete'; restored: boolean; conflict?: string; diff?: string }> };
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
  private async image(cwd: string, path: string): Promise<Image> {
    const target = this.check(cwd, path);
    let stat;
    try { stat = await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('检查点不支持目录、符号链接或硬链接文件');
    if (stat.size > 2 * 1024 * 1024) throw new Error('单个文件超过 2 MB 检查点上限');
    const data = await readFile(target);
    if (data.length > 2 * 1024 * 1024) throw new Error('文件在读取期间超过检查点上限');
    this.check(cwd, path);
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
      const before = await this.image(cwd, target);
      bytes += before?.data.length ?? 0;
      if (bytes > 16 * 1024 * 1024) throw new Error('单次检查点超过 16 MB，请拆分操作');
      files.push({ path: target, before });
    }
    const record = { id: newId('cp'), threadId, turnId, operationId, cwd, title: title.slice(0, 160), createdAt: new Date().toISOString(), complete: false, files };
    await this.save(record);
    return record;
  }
  async complete(record: RecordData) {
    for (const entry of record.files) entry.after = await this.image(record.cwd, entry.path);
    record.files = record.files.filter(entry => hash(entry.before) !== hash(entry.after));
    record.complete = true;
    if (record.files.length) await this.save(record);
    else await unlink(this.file(record.threadId, record.id));
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
    for (const file of record.files) this.check(cwd, file.path);
    return record;
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
  async restore(threadId: string, id: string, cwd: string, paths: string[] | undefined, assertIdle: () => void) {
    this.assertAvailable(cwd);
    this.restoring.add(cwd);
    try { return await this.exclusive(cwd, async () => {
      assertIdle();
      const record = await this.load(threadId, id, cwd);
      if (!record.complete) throw new Error('检查点记录尚未完整，无法恢复');
      if (paths && (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !record.files.some(file => file.path === path)))) throw new Error('恢复列表包含未记录的文件');
      const selected = record.files.filter(file => !file.restored && (!paths || paths.includes(file.path)));
      if (!selected.length) throw new Error('没有可恢复的文件');
      // Validate the entire selection before touching any file.
      for (const file of selected) if (hash(await this.image(cwd, file.path)) !== hash(file.after)) throw new Error('恢复冲突：' + file.path + ' 已被后续操作或手动修改');
      for (const file of selected) {
        assertIdle();
        if (hash(await this.image(cwd, file.path)) !== hash(file.after)) throw new Error('恢复冲突：' + file.path);
        const target = this.check(cwd, file.path);
        if (file.before === null) await unlink(target);
        else { await mkdir(dirname(target), { recursive: true }); this.check(cwd, file.path); await writeFile(target, Buffer.from(file.before.data, 'base64')); await chmod(target, file.before.mode); }
        file.restored = true;
        await this.save(record);
      }
      return { restored: selected.map(file => file.path), operationId: record.operationId };
    }); } finally { this.restoring.delete(cwd); }
  }
}
