import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { isInsideWorkspace, isSensitivePath, type Kernel } from '@smalt/kernel';
import { FileContexts } from './file-context.js';
import { readBounded } from './read-bounded.js';
import { readContextFile, type DocumentLoader } from './context-files.js';
import type { LocalSpaces } from './local-spaces.js';
import type { WorkspaceAccess } from './workspace-access.js';

type Dependencies = { home: string; kernel: Kernel; spaces: LocalSpaces; access: WorkspaceAccess; trusted(e: IpcMainInvokeEvent): boolean; requireWorkspace(path: string): Promise<void>; local(id: string): void; reader: DocumentLoader };
export class FileContextBridge {
  readonly contexts: FileContexts;
  constructor(private deps: Dependencies) {
    this.contexts = new FileContexts(deps.home, path => deps.access.has(path));
    ipcMain.handle('smalt:file-context', (e, action, value = {}) => { if (!deps.trusted(e) || !value || typeof value !== 'object' || Array.isArray(value)) throw Error('不可信的文件环境请求'); return this.action(action, value); });
  }
  private text(value: unknown, max = 4096): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw Error('文件环境参数无效'); return value; }
  async scope(scope: string) {
    this.text(scope);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(scope)) {
      const meta = this.deps.kernel.threads.read(scope).meta; this.deps.local(scope);
      if (meta.archived || meta.collaboration) throw Error('请在未归档的普通本机对话中管理资料');
      await this.deps.requireWorkspace(meta.cwd); return this.ensureThread(scope, meta.cwd);
    }
    if (!this.deps.spaces.available(scope)) throw Error('草稿文件空间不属于当前未发送对话');
    await this.deps.requireWorkspace(scope); return this.contexts.ensureDraft(scope);
  }
  draft(output: string) { return this.contexts.ensureDraft(output); }
  ensureThread(threadId:string,cwd:string){return this.contexts.ensureThread(threadId,cwd,this.deps.spaces.forThread(threadId));}
  fileRoot(threadId: string, path: string) { this.deps.local(threadId); const meta = this.deps.kernel.threads.read(threadId).meta; this.ensureThread(threadId, meta.cwd); return this.contexts.fileRoot(threadId, path); }
  private async pick(kind: 'source' | 'workspace', file: boolean) {
    const selected = await dialog.showOpenDialog({ title: kind === 'workspace' ? '选择可修改的工作目录' : file ? '添加只读原文件引用' : '添加只读资料文件夹', properties: [file ? 'openFile' : 'openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return undefined; const path = selected.filePaths[0];
    if (this.deps.spaces.contains(path) || isInsideWorkspace(this.deps.home, path)) throw Error('应用私有存储不能作为外部资料或工作目录');
    if (kind === 'workspace') await this.deps.requireWorkspace(path); return path;
  }
  private async action(action: unknown, value: Record<string, any>): Promise<any> {
    if (typeof action !== 'string') throw Error('文件环境操作无效');
    if (action === 'project-open') { if (value.projectId !== undefined) this.deps.kernel.projects.require(this.text(value.projectId, 128)); return this.contexts.projectDraft(value.projectId); }
    if (action === 'project-discard') { this.contexts.discardProject(this.text(value.token, 64)); return; }
    if (action === 'project-save') { this.deps.kernel.projects.require(this.text(value.projectId, 128)); this.contexts.saveProject(this.text(value.token, 64), value.projectId); return { saved: true }; }
    if (action === 'project-add') { this.contexts.projectView(this.text(value.token, 64)); if (!['source', 'workspace'].includes(value.kind) || value.kind === 'workspace' && value.file) throw Error('无效的资料类型'); const path = await this.pick(value.kind, value.file === true); return path ? this.contexts.projectAdd(value.token, path, value.kind, value.file === true) : this.contexts.projectView(value.token); }
    if (action === 'project-remove') return this.contexts.projectRemove(this.text(value.token, 64), this.text(value.rootId, 64));
    if (action === 'project-primary') return this.contexts.projectPrimary(this.text(value.token, 64), value.rootId === undefined ? undefined : this.text(value.rootId, 64));
    if (action === 'storage') return { data: this.deps.home, files: this.deps.spaces.root };
    const scope = this.text(value.scope); await this.scope(scope);
    if (action === 'get') return this.contexts.view(scope);
    if (action === 'apply-project') { if (value.projectId) this.deps.kernel.projects.require(this.text(value.projectId, 128)); const result = this.contexts.applyProject(scope, value.projectId); return { ...result, projectDefault: value.projectId ? this.contexts.projectConfig(value.projectId).primary : undefined }; }
    if (action === 'add') { if (!['source', 'workspace'].includes(value.kind) || value.kind === 'workspace' && value.file) throw Error('无效的资料类型'); const path = await this.pick(value.kind, value.file === true); await this.scope(scope); return path ? this.contexts.add(scope, path, value.kind, value.file === true) : this.contexts.view(scope); }
    if (action === 'remove') return this.contexts.remove(scope, this.text(value.rootId, 64));
    if (action === 'primary') return this.contexts.primary(scope, value.rootId === undefined ? undefined : this.text(value.rootId, 64));
    if (action === 'search') return this.contexts.search(scope, this.text(value.rootId, 64), this.text(value.query ?? '', 256));
    if (action === 'source-preview') return this.contexts.preview(scope, this.text(value.path), this.deps.reader);
    if (action === 'source-resolve') { if (!Array.isArray(value.refs) || value.refs.length > 10) throw Error('最多引用 10 项资料'); return this.contexts.resolve(scope, value.refs, this.deps.reader); }
    if (action === 'files') { if (!['outputs', 'work'].includes(value.area)) throw Error('无效文件列表类型'); return this.contexts.files(scope, value.area, this.text(value.query ?? '', 256), value.rootId); }
    if (action === 'preview' || action === 'reveal' || action === 'export' || action === 'versions') {
      const path = this.text(value.path), view = this.contexts.view(scope), root = this.contexts.fileRoot(scope, path), target = resolve(view.cwd, path);
      if (!isInsideWorkspace(root, target) || isSensitivePath(root, target)) throw Error('文件超出授权范围');
      if (action === 'preview') return readContextFile(root, target, this.deps.reader);
      if (action === 'reveal') { shell.showItemInFolder(target); return { revealed: true }; }
      if (action === 'versions') return this.contexts.versions(scope, target);
      const bytes = value.digest ? this.contexts.version(scope, target, this.text(value.digest, 64)) : await readBounded(target, 15 * 1024 * 1024);
      const selected = await dialog.showSaveDialog({ title: '另存产物副本（保留原文件与任务位置）', defaultPath: target });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      if (resolve(selected.filePath) === target || isSensitivePath(dirname(selected.filePath), selected.filePath) || /^[\\/]{2}/.test(selected.filePath)) throw Error('请选择普通本地文件的新名称，不能覆盖原件或敏感位置');
      await this.scope(scope); this.contexts.fileRoot(scope, target);
      await writeFile(selected.filePath, bytes, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code === 'EEXIST') throw Error('目标文件已存在，请换一个名称；没有覆盖已有文件'); throw error; });
      return { canceled: false, path: selected.filePath };
    }
    throw Error('无效的文件环境操作');
  }
  dispose() { ipcMain.removeHandler('smalt:file-context'); }
}
