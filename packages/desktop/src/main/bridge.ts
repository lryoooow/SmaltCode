/**
 * Kernel ↔ renderer bridge (main process side), hardened:
 *
 *  - every IPC handler verifies the sender frame is our own page
 *  - kernel methods are called through an allowlist
 *  - approvals time out and are denied when the window reloads/dies
 *  - settings patches are schema-checked; API keys are encrypted with
 *    safeStorage and never persist in plaintext
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Kernel,
  ensureProjectTrust,
  updateUserSettingsFile,
  isInsideWorkspace,
  isSensitivePath,
  smaltHome,
  loadSettings, apiKeyFor, normalizeEndpoint,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientPort,
  type UserInputRequest,
} from '@smalt/kernel';
import { isValidWorkspace } from './workspace.js';
import { readContextFile, resolveContext, searchContextFiles, type ContextReference } from './context-files.js';
import { DesktopNotifications } from './notifications.js';
import { SkillStore, parseSkill, type SkillPreview } from './skills.js';
import { downloadSkill } from './safe-download.js';
import { DocumentReader, documentWorkerPath } from './document-reader.js';
import { AttachmentStore } from './attachments.js';
import type { DesktopOverview } from '../shared/overview.js';
import { WorkspaceAccess } from './workspace-access.js';
import { readBounded } from './read-bounded.js';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const KERNEL_METHODS = new Set([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/list',
  'thread/read',
  'thread/archive',
  'thread/restore', 'thread/delete', 'thread/project/update',
  'project/list', 'project/create', 'project/update', 'project/delete',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/compact/start',
  'thread/rename',
  'thread/pin',
  'thread/settings/update',
  'thread/permissions/reset',
  'checkpoint/list', 'checkpoint/restore',
]);

const SETTING_KEYS = new Set(['defaultProvider', 'defaultModel', 'permissions', 'providers']);
const MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk']);

export class DesktopBridge {
  readonly kernel: Kernel;
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly pendingInputs = new Map<string, (t: string) => void>();
  private readonly requestThreads = new Map<string, string>();
  private readonly notifications: DesktopNotifications;
  private readonly skills: SkillStore;
  private readonly documents: DocumentReader;
  private readonly attachments: AttachmentStore;
  private readonly skillPreviews = new Map<string, { preview: SkillPreview; expires: number }>();
  private skillDownloads = 0;
  private readonly workspaceAccess = new WorkspaceAccess(join(smaltHome(), 'workspace-access.json'));
  private readonly lifecycle: Array<() => void> = [];
  private settingsQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly webContents: WebContents, private readonly pageURL: string) {
    this.notifications = new DesktopNotifications(webContents);
    this.skills = new SkillStore(join(smaltHome(), 'skills'));
    this.documents = new DocumentReader(documentWorkerPath(__dirname));
    this.attachments = new AttachmentStore(join(smaltHome(), 'attachments'), app.getPath('home'), (name, bytes) => this.documents.read(name, bytes));
    const port: ClientPort = {
      notify: (method, params) => {
        this.send('smalt:notify', { method, params });
        const data = params as { threadId?: string; turnId?: string; interrupted?: boolean; summary?: { assessment?: import('../../../kernel/src/protocol/assessment.js').TurnAssessment } } | undefined;
        if (data?.threadId && (method === 'thread/deleted' || method === 'thread/archived')) this.notifications.resolveThread(data.threadId);
        if (data?.threadId && (method === 'turn/failed' || (method === 'turn/completed' && !data.interrupted))) {
          const title = this.kernel.threads.get(data.threadId)?.meta.title ?? '任务';
          const state = data.summary?.assessment?.status;
          const label = state === 'findings' ? '检查完成，发现问题' : state === 'unverified' ? '部分验证未完成' : state === 'needsAttention' ? '仍有事项需处理' : '任务已完成';
          this.notifications.show(data.threadId, data.threadId + ':' + method + ':' + data.turnId, method === 'turn/failed' ? '任务失败' : label, title);
        }
      },
      requestApproval: (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          this.requestThreads.set(req.itemId, req.threadId);
          this.notifications.show(req.threadId, req.itemId, '需要审批', this.kernel.threads.get(req.threadId)?.meta.title ?? req.title);
          this.pendingApprovals.set(req.itemId, (decision) => {
            clearTimeout(timer); this.requestThreads.delete(req.itemId);
            this.send('smalt:resolved', { id: req.itemId }); resolve(decision);
          });
          this.send('smalt:approval', { req });
          const timer = setTimeout(() => {
            this.pendingApprovals.get(req.itemId)?.({ decision: 'deny', reason: 'approval timed out' });
            this.pendingApprovals.delete(req.itemId);
          }, APPROVAL_TIMEOUT_MS);
          void timer;
        }),
      askUser: (req) =>
        new Promise<string>((resolve) => {
          this.requestThreads.set(req.itemId, req.threadId);
          this.notifications.show(req.threadId, req.itemId, '等待回答', this.kernel.threads.get(req.threadId)?.meta.title ?? req.question);
          this.pendingInputs.set(req.itemId, (answer) => {
            clearTimeout(timer); this.requestThreads.delete(req.itemId);
            this.send('smalt:resolved', { id: req.itemId }); resolve(answer);
          });
          const timer = setTimeout(() => { this.pendingInputs.get(req.itemId)?.(''); this.pendingInputs.delete(req.itemId); }, APPROVAL_TIMEOUT_MS);
          this.send('smalt:input', { req });
        }),
      cancelApproval: (id) => {
        this.pendingApprovals.get(id)?.({ decision: 'deny', reason: '审批已随任务权限更新或取消而结束' });
        this.pendingApprovals.delete(id);
      },
    };
    this.kernel = new Kernel({
      cwd: app.getPath('home'), // settings root only; threads carry their own cwd
      settings: loadSettings(app.getPath('home'), undefined, undefined, false),
      modelDiscovery: true,
      client: port,
      log: (msg) => console.log(`[kernel] ${msg}`),
    });
    this.kernel.threads.recoverInterrupted();
    // getURL() is still empty during construction; the app loads exactly one
    // local page, so trust file:// frames and pin the origin once loaded
    this.restoreEncryptedKeys();
    this.registerHandlers();
    this.watchWindowLifecycle();
  }

  private async requireWorkspace(cwd: string): Promise<void> {
    await this.workspaceAccess.ensure(cwd, async dir => (await dialog.showMessageBox({
      type: 'question', title: '允许访问工作区', message: '允许 SmaltCode 使用这个本机文件夹？',
      detail: dir + '\n\n允许后可搜索、预览和引用其中的资料。任务修改与命令仍遵循所选权限。',
      buttons: ['允许此文件夹', '取消'], defaultId: 1, cancelId: 1,
    })).response === 0);
  }

  private async confirmElevation(next: unknown, current: string): Promise<void> {
    const rank: Record<string, number> = { plan: 4, default: 3, dontAsk: 3, acceptEdits: 2, bypassPermissions: 0 };
    if (typeof next !== 'string' || rank[next] === undefined || rank[next]! >= rank[current]!) return;
    const result = await dialog.showMessageBox({ type: 'warning', title: '确认调整操作权限', message: '允许扩大此任务的操作权限？',
      detail: `权限从 ${current} 调整为 ${next}。请确认这是你刚才在界面中选择的操作。`, buttons: ['确认调整', '取消'], defaultId: 1, cancelId: 1 });
    if (result.response !== 0) throw new Error('已取消权限调整');
  }

  /** sender must be our own page, not an embedded/foreign frame */
  private trusted(e: IpcMainInvokeEvent): boolean {
    return e.sender === this.webContents && e.senderFrame === this.webContents.mainFrame &&
      e.senderFrame.url === this.pageURL && this.webContents.getURL() === this.pageURL;
  }

  private send(channel: string, payload: unknown): void {
    if (channel === 'smalt:resolved') this.notifications.resolve((payload as { id: string }).id);
    if (this.webContents.isDestroyed()) return;
    try { this.webContents.send(channel, payload); } catch { /* renderer was lost between the check and send */ }
  }

  /** A reloaded/crashed window can never answer pending approvals → deny all. */
  private watchWindowLifecycle(): void {
    const failAll = () => {
      for (const meta of this.kernel.threads.listMetas()) {
        const runtime = this.kernel.threads.get(meta.id);
        if (runtime?.stateMachine.isRunning()) this.kernel.threads.interrupt(meta.id);
      }
      for (const [id, resolve] of this.pendingApprovals) {
        resolve({ decision: 'deny', reason: 'window reloaded' });
        this.pendingApprovals.delete(id);
      }
      for (const [id, resolve] of this.pendingInputs) {
        resolve('');
        this.pendingInputs.delete(id);
      }
    };
    const navigation = (_e: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !inPlace) failAll(); };
    this.webContents.on('did-start-navigation', navigation);
    this.webContents.on('render-process-gone', failAll);
    this.webContents.on('destroyed', failAll);
    this.lifecycle.push(() => { this.webContents.removeListener('did-start-navigation', navigation); this.webContents.removeListener('render-process-gone', failAll); this.webContents.removeListener('destroyed', failAll); });
  }

  /** Decrypt apiKeyEnc entries from settings and inject them into the gateway. */
  private restoreEncryptedKeys(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const providers = this.kernel.getSettings().providers as Record<
      string,
      { apiKeyEnc?: string; baseUrl: string; apiKeyEndpoint?: string }
    >;
    for (const [name, cfg] of Object.entries(providers)) {
      if (!cfg?.apiKeyEnc) continue;
      if (cfg.apiKeyEndpoint && normalizeEndpoint(cfg.apiKeyEndpoint) !== normalizeEndpoint(cfg.baseUrl)) continue;
      try {
        const key = safeStorage.decryptString(Buffer.from(cfg.apiKeyEnc, 'base64'));
        if (key) this.kernel.gateway.overrideProvider(name, { apiKey: key });
      } catch {
        // encrypted on another OS user / machine — ignore, user re-enters
      }
    }
  }

  private registerHandlers(): void {
    ipcMain.handle('smalt:call', async (e, method: string, params: unknown) => {
      if (!this.trusted(e) || !KERNEL_METHODS.has(method)) {
        throw new Error(`method not permitted: ${method}`);
      }
      // thread/start carries a workspace: validate it again at creation time
      // (N5) and run the project-trust flow (N1) before anything loads
      if (method === 'thread/start') {
        const p = (params ?? {}) as { cwd?: string };
        if (!p.cwd || typeof p.cwd !== 'string') {
          throw new Error('thread/start requires a project folder (cwd)');
        }
        const check = isValidWorkspace(p.cwd);
        if (!check.ok) throw new Error(check.reason);
        await this.requireWorkspace(p.cwd);
        await ensureProjectTrust(
          p.cwd,
          async (dir) => {
            if (app.commandLine.hasSwitch('smoke-test')) return false;
            let requested = '';
            try {
              const config = JSON.parse(readFileSync(resolve(dir, '.smalt/settings.json'), 'utf8')) as Record<string, unknown>;
              const permissions = config.permissions as { allow?: string[]; mode?: string } | undefined;
              const providers = config.providers as Record<string, { baseUrl?: string }> | undefined;
              const hooks = config.hooks && typeof config.hooks === 'object' ? Object.keys(config.hooks) : [];
              requested = '\n\n当前配置：\n' +
                `权限模式：${permissions?.mode ?? '继承默认'}\n` +
                `允许规则：${permissions?.allow?.join(', ') || '无'}\n` +
                `Hooks：${hooks.join(', ') || '无'}\n` +
                `项目服务端点：${Object.entries(providers ?? {}).map(([name, provider]) => `${name}: ${provider?.baseUrl ?? '未指定'}`).join('\n') || '无'}`;
            } catch { requested = '\n配置文件无效，将保持不信任。'; }
            const { response } = await dialog.showMessageBox({
              type: 'warning',
              title: '信任项目配置',
              message: '这个项目包含自己的助手配置，或配置已发生变化',
              detail:
                `${dir} contains .smalt/settings.json.\n\n` +
                '信任后可启用项目的允许规则和 hooks。不信任时仅应用更严格的权限。已有服务商的地址与密钥不会被项目覆盖。' + requested,
              buttons: ['信任当前配置', '保持不信任'],
              defaultId: 1,
              cancelId: 1,
            });
            return response === 0;
          },
          (msg) => console.log(`[trust] ${msg}`),
        );
      }
      if (method === 'project/create' || method === 'project/update') {
        const cwd = (params as { cwd?: unknown })?.cwd;
        if (cwd !== undefined && cwd !== null && cwd !== '') {
          if (typeof cwd !== 'string') throw new Error('Invalid project workspace');
          const check = isValidWorkspace(cwd); if (!check.ok) throw new Error(check.reason);
          await this.requireWorkspace(cwd);
        }
      }
      if (['thread/resume', 'thread/read', 'turn/start', 'turn/steer', 'checkpoint/list', 'checkpoint/restore', 'thread/compact/start'].includes(method)) {
        const p = params as { threadId?: string };
        if (typeof p?.threadId !== 'string') throw new Error('Invalid threadId');
        const { meta } = this.kernel.threads.read(p.threadId);
        const check = isValidWorkspace(meta.cwd);
        if (!check.ok) throw new Error(check.reason);
        await this.requireWorkspace(meta.cwd);
      }
      if (method === 'thread/start' || method === 'thread/settings/update') {
        const p = params as { threadId?: string; permissionMode?: string };
        const current = method === 'thread/start' ? this.kernel.getSettings().permissions.mode : this.kernel.threads.read(String(p?.threadId)).meta.permissionMode ?? this.kernel.getSettings().permissions.mode;
        await this.confirmElevation(p?.permissionMode, current);
      }
      if (method === 'turn/interrupt') {
        const threadId = String((params as { threadId?: string })?.threadId);
        // Resolve reverse requests as well as aborting model/tool execution.
        for (const [id, pending] of this.pendingApprovals) {
          if (this.requestThreads.get(id) !== threadId) continue;
          pending({ decision: 'deny', reason: '任务已停止' }); this.pendingApprovals.delete(id);
        }
        for (const [id, pending] of this.pendingInputs) {
          if (this.requestThreads.get(id) !== threadId) continue;
          pending(''); this.pendingInputs.delete(id);
        }
      }
      return this.kernel.handle(method, params);
    });

    ipcMain.handle('smalt:approval:respond', (e, id: string, decision: ApprovalDecision) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      if (typeof id !== 'string' || id.length > 200 || decision && 'reason' in decision && (typeof decision.reason !== 'string' || decision.reason.length > 4000)) throw new Error('Invalid approval response');
      if (!decision || !['allow', 'deny'].includes(decision.decision) || ('remember' in decision && decision.remember && !['session', 'always'].includes(decision.remember)) || ('scope' in decision && decision.scope && !['operation', 'category', 'batch'].includes(decision.scope))) throw new Error('Invalid approval response');
      this.pendingApprovals.get(id)?.(decision);
      this.pendingApprovals.delete(id);
    });

    ipcMain.handle('smalt:input:respond', (e, id: string, text: string) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      if (typeof id !== 'string' || id.length > 200 || typeof text !== 'string' || text.length > 20000) throw new Error('Invalid answer');
      this.pendingInputs.get(id)?.(text);
      this.pendingInputs.delete(id);
    });

    /** folder picker enforcing workspace rules */
    ipcMain.handle('smalt:pick-folder', async (e, defaultPath?: string) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      if (app.commandLine.hasSwitch('smoke-test')) {
        return { canceled: true as const };
      }
      const result = await dialog.showOpenDialog({
        title: '选择任务的工作文件夹',
        defaultPath: defaultPath,
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
      const dir = result.filePaths[0];
      const check = isValidWorkspace(dir);
      if (!check.ok) return { canceled: true as const, reason: check.reason };
      this.workspaceAccess.grant(dir);
      return { canceled: false as const, dir };
    });

    ipcMain.handle('smalt:pick-files', async (e) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const result = await dialog.showOpenDialog({ title: '添加文件引用', properties: ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths.filter(p => !isSensitivePath(app.getPath('home'), p)).slice(0, 10);
    });
    ipcMain.handle('smalt:context', async (e, cwd: string, action: string, value: unknown) => {
      if (!this.trusted(e) || typeof cwd !== 'string') throw new Error('untrusted request');
      const scope = isValidWorkspace(cwd); if (!scope.ok) throw new Error(scope.reason);
      await this.requireWorkspace(cwd);
      if (action === 'search' && typeof value === 'string' && value.length <= 300) return searchContextFiles(cwd, value);
      if (action === 'preview' && typeof value === 'string') return readContextFile(cwd, value, (name, bytes) => this.documents.read(name, bytes));
      if (action === 'resolve') {
        const refs = value as ContextReference[];
        if (!Array.isArray(refs) || refs.length > 10 || refs.some(ref => !ref || typeof ref.path !== 'string' || ref.path.length > 4096)) throw new Error('最多引用 10 项有效资料');
        const [files, skills, attachments] = await Promise.all([
          resolveContext(cwd, refs.filter(ref => !ref.path.startsWith('skill:') && !ref.path.startsWith('attachment:')), (name, bytes) => this.documents.read(name, bytes)),
          this.skills.resolve(refs.filter(ref => ref.path.startsWith('skill:'))),
          this.attachments.resolve(refs.filter(ref => ref.path.startsWith('attachment:'))),
        ]);
        const images = [...files.images, ...attachments.images];
        if (images.length > 4 || images.reduce((sum, image) => sum + image.dataBase64.length, 0) > 28 * 1024 * 1024) throw new Error('每条消息最多 4 张图片，合计不超过 20 MB');
        const text = files.text + attachments.text + skills.text;
        if (text.length > 100_000) throw new Error('引用资料合计过长，请减少文件、选区或技能');
        return { text, images, references: [...files.references, ...attachments.references, ...skills.references] };
      }
      throw new Error('无效的上下文操作');
    });
    ipcMain.handle('smalt:activity', (e, threadId: string | null, enabled: boolean) => {
      if (!this.trusted(e) || (threadId !== null && typeof threadId !== 'string') || typeof enabled !== 'boolean') throw new Error('untrusted request');
      this.notifications.configure(threadId, enabled);
    });
    ipcMain.handle('smalt:file', async (e, threadId: string, path: string, action: string) => {
      if (!this.trusted(e) || typeof path !== 'string' || typeof threadId !== 'string') throw new Error('untrusted request');
      const cwd = this.kernel.threads.read(threadId).meta.cwd;
      await this.requireWorkspace(cwd);
      if (path.startsWith('attachment:')) {
        if (action !== 'read') throw new Error('附件副本仅支持应用内预览');
        return this.attachments.preview(path.slice('attachment:'.length));
      }
      if (!isInsideWorkspace(cwd, path) || isSensitivePath(cwd, path)) throw new Error('文件超出工作区或属于敏感路径');
      const target = resolve(cwd, path);
      if (action === 'reveal') { shell.showItemInFolder(target); return { ok: true }; }
      if (action !== 'read') throw new Error('Invalid file action');
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error('只能预览文件');
      const supported = /\.(?:pdf|docx|xlsx|png|jpe?g)$/i.test(path);
      if (stat.size > (supported ? 15 * 1024 * 1024 : 512 * 1024)) return { binary: true, size: stat.size, text: '', reason: supported ? '文档超过 15 MB，请缩小文件后再试' : '文本文件较大，请在资源管理器中查看' };
      try { return await readContextFile(cwd, path, (name, bytes) => this.documents.read(name, bytes)); }
      catch (error) { return { binary: true, size: stat.size, text: '', reason: error instanceof Error ? error.message : '此格式暂不支持预览' }; }
    });
    ipcMain.handle('smalt:skills', async (e, action: string, value: unknown) => {
      if (!this.trusted(e)) throw new Error('untrusted request');
      const p = value as Record<string, unknown> | undefined;
      if (action === 'list') return this.skills.list();
      if (action === 'read' && typeof p?.id === 'string') return this.skills.read(p.id);
      if (action === 'configure' && typeof p?.id === 'string' && typeof p.enabled === 'boolean') { await this.skills.configure(p.id, p.enabled); return { ok: true }; }
      if (action === 'remove' && typeof p?.id === 'string') { await this.skills.remove(p.id); return { ok: true }; }
      if (action === 'confirm' && typeof p?.token === 'string') {
        const entry = this.skillPreviews.get(p.token);
        if (!entry || entry.expires < Date.now()) throw new Error('导入预览已过期，请重新读取');
        const result = await this.skills.import(entry.preview); this.skillPreviews.delete(p.token); return result;
      }
      let preview: SkillPreview;
      if (action === 'preview-url' && typeof p?.url === 'string') {
        if (this.skillDownloads >= 2) throw new Error('已有技能正在读取，请稍后再试');
        this.skillDownloads++;
        try { const downloaded = await downloadSkill(p.url); preview = parseSkill(downloaded.text, 'url', downloaded.origin); }
        finally { this.skillDownloads--; }
      } else if (action === 'preview-file') {
        const picked = await dialog.showOpenDialog({ title: '选择 SKILL.md 技能文件', filters: [{ name: '技能说明', extensions: ['md'] }], properties: ['openFile'] });
        if (picked.canceled || !picked.filePaths[0]) return null;
        const file = picked.filePaths[0]; if (isSensitivePath(app.getPath('home'), file)) throw new Error('不能导入敏感路径中的文件');
        const info = await stat(file); if (!info.isFile() || info.size > 64 * 1024) throw new Error('技能文件超过 64 KB');
        const bytes = await readBounded(file, 64 * 1024); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (isSensitivePath(app.getPath('home'), file)) throw new Error('文件路径已变化');
        preview = parseSkill(text, 'file', file);
      } else if (action === 'preview-text' && typeof p?.text === 'string') preview = parseSkill(p.text, 'manual', '用户粘贴');
      else throw new Error('无效的技能操作');
      for (const [token, entry] of this.skillPreviews) if (entry.expires < Date.now()) this.skillPreviews.delete(token);
      if (this.skillPreviews.size >= 10) this.skillPreviews.delete(this.skillPreviews.keys().next().value!);
      const token = randomUUID(); this.skillPreviews.set(token, { preview, expires: Date.now() + 10 * 60_000 });
      return { ...preview, token };
    });
    ipcMain.handle('smalt:attachments:pick', async e => {
      if (!this.trusted(e)) throw new Error('untrusted request');
      const picked = await dialog.showOpenDialog({ title: '添加图片或资料', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片、文档与文本', extensions: ['png','jpg','jpeg','pdf','docx','xlsx','md','txt','csv','json','ts','tsx','js','py','html','css'] }, { name: '所有文件', extensions: ['*'] }] });
      if (picked.canceled) return { attachments: [], errors: [] };
      if (picked.filePaths.length > 10) throw new Error('一次最多添加 10 个文件');
      const results = await Promise.allSettled(picked.filePaths.map(path => this.attachments.fromFile(path)));
      return { attachments: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), errors: results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : '文件添加失败'] : []) };
    });
    ipcMain.handle('smalt:attachments:image', (e, base64: unknown, mime: unknown) => {
      if (!this.trusted(e)) throw new Error('untrusted request'); return this.attachments.fromImage(base64, mime);
    });
    ipcMain.handle('smalt:attachments:preview', (e, id: string) => {
      if (!this.trusted(e) || typeof id !== 'string') throw new Error('untrusted request'); return this.attachments.preview(id);
    });
    ipcMain.handle('smalt:overview', async e => {
      if (!this.trusted(e)) throw new Error('untrusted request'); return this.overview();
    });
    ipcMain.handle('smalt:diagnostics:export', async e => {
      if (!this.trusted(e)) throw new Error('untrusted request');
      const overview = await this.overview();
      const picked = await dialog.showSaveDialog({ title: '导出脱敏诊断', defaultPath: 'SmaltCode-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePath) return { canceled: true };
      if (isSensitivePath(app.getPath('home'), picked.filePath)) throw new Error('请选择普通资料目录保存诊断');
      await writeFile(picked.filePath, JSON.stringify({ generatedAt: new Date().toISOString(), diagnostics: overview.diagnostics, counts: { conversations: overview.usage.conversations, recoverable: overview.usage.rows.filter(row => row.recovery).length } }, null, 2), 'utf8');
      return { canceled: false };
    });
    ipcMain.handle('smalt:window', (e, action: string) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const win = BrowserWindow.fromWebContents(this.webContents);
      if (action === 'minimize') win?.minimize();
      else if (action === 'maximize') { if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); }
      else if (action === 'close') win?.close();
      else throw new Error('Invalid window action');
    });

    ipcMain.handle('smalt:settings:load', (e) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const settings = this.kernel.getSettings();
      return {
        providers: Object.fromEntries(
          Object.entries(settings.providers).map(([name, cfg]) => [
            name,
            {
              baseUrl: cfg.baseUrl,
              wire: cfg.wire,
              apiKeyEnv: cfg.apiKeyEnv,
                hasKey: Boolean(apiKeyFor(this.kernel.gateway.providerConfig(name))),
              defaultModel: cfg.defaultModel,
              contextWindow: cfg.contextWindow,
              modelContextWindows: cfg.modelContextWindows,
            },
          ]),
        ),
        keyStorage: safeStorage.isEncryptionAvailable() ? 'encrypted' : 'session',
        compactThreshold: settings.compact.threshold,
        catalogs: Object.fromEntries(Object.keys(settings.providers).map(name => [name, this.kernel.gateway.modelsFor(name)])),
        effective: {
          defaultProvider: settings.defaultProvider,
          defaultModel: settings.defaultModel,
          permissionMode: settings.permissions.mode,
        },
      };
    });

    ipcMain.handle('smalt:settings:save', (e, patch: Record<string, unknown>) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const operation = this.settingsQueue.then(() => this.saveSettings(sanitizePatch(patch)));
      this.settingsQueue = operation.catch(() => {}); return operation;
    });
    ipcMain.handle('smalt:settings:test', async (e, provider: string, model: string) => {
      if (!this.trusted(e) || !this.kernel.getSettings().providers[provider] || typeof model !== 'string' || !model.trim()) throw new Error('Invalid provider or model');
      const signal = AbortSignal.timeout(15_000);
      for await (const _delta of this.kernel.gateway.stream({ provider, model }, { messages: [{ role: 'user', content: 'Reply OK.' }], tools: [], maxOutputTokens: 8, signal })) { /* verify real response */ }
      return { ok: true };
    });
    ipcMain.handle('smalt:models:list', async (e, provider: string, force = false, model?: string) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      if (typeof provider !== 'string' || !Object.hasOwn(this.kernel.getSettings().providers, provider) || typeof force !== 'boolean' || model !== undefined && (typeof model !== 'string' || model.length > 256 || /[\x00-\x1f]/.test(model))) throw new Error('Invalid model provider');
      await this.kernel.gateway.refreshModels(provider, force);
      if (model) await this.kernel.gateway.enrichModel(provider, model);
      return this.kernel.gateway.modelsFor(provider);
    });
  }

  private async saveSettings(clean: Record<string, unknown>) {
    const current = this.kernel.getSettings();
    const permissions = clean.permissions as { mode?: string; allow?: string[]; deny?: string[]; ask?: string[] } | undefined;
    await this.confirmElevation(permissions?.mode, current.permissions.mode);
    if (permissions?.allow?.some(rule => !current.permissions.allow.includes(rule)) || permissions?.deny && current.permissions.deny.some(rule => !permissions.deny!.includes(rule)) || permissions?.ask && current.permissions.ask.some(rule => !permissions.ask!.includes(rule))) {
      const result = await dialog.showMessageBox({ type: 'warning', title: '确认权限规则', message: '允许扩大操作规则？', detail: '此修改会增加自动许可，或移除已有审批和拒绝规则。', buttons: ['确认修改', '取消'], defaultId: 1, cancelId: 1 });
      if (result.response !== 0) throw new Error('已取消权限规则修改');
    }
    const providers = clean.providers as Record<string, Record<string, unknown>> | undefined;
    const freshKeys: Array<[string, string]> = [];
    for (const [name, cfg] of Object.entries(providers ?? {})) {
      const previous = current.providers[name];
      const endpoint = String(cfg.baseUrl ?? previous?.baseUrl ?? '');
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new Error('服务地址无效'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('服务地址仅支持不含账号、查询参数或片段的 HTTP/HTTPS 地址');
      const changed = normalizeEndpoint(endpoint) !== normalizeEndpoint(previous?.baseUrl ?? '');
      if (changed) {
        const result = await dialog.showMessageBox({ type: 'warning', title: '确认模型服务地址', message: '允许将模型请求发送到这个地址？', detail: `${name}\n原地址：${previous?.baseUrl ?? '未设置'}\n新地址：${endpoint}\n\n旧密钥不会自动用于新地址；请为新地址重新填写密钥。`, buttons: ['确认地址', '取消'], defaultId: 1, cancelId: 1 });
        if (result.response !== 0) throw new Error('已取消服务地址修改');
        cfg.apiKeyEndpoint = previous?.apiKeyEndpoint ?? previous?.baseUrl ?? endpoint;
        cfg.apiKeyEnc = null; // old encrypted credentials never follow a redirect
      }
      const plain = typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : !changed ? previous?.apiKey : undefined;
      if (plain) {
        freshKeys.push([name, plain]);
        cfg.apiKeyEndpoint = normalizeEndpoint(endpoint); cfg.apiKeyEnv = '';
        cfg.apiKeyEnc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null;
      }
      cfg.apiKey = null; // never write plaintext credentials
    }
    const next = updateUserSettingsFile(app.getPath('home'), clean, false);
    this.kernel.applySettings(next);
    this.restoreEncryptedKeys();
    for (const [name, key] of freshKeys) this.kernel.gateway.overrideProvider(name, { apiKey: key });
    return { ok: true };
  }

  private encState(): Record<string, boolean> {
    const state: Record<string, boolean> = {};
    const providers = this.kernel.getSettings().providers as Record<string, { apiKeyEnc?: string }>;
    for (const [name, cfg] of Object.entries(providers)) {
      state[name] = Boolean(cfg?.apiKeyEnc);
    }
    return state;
  }

  private async overview(): Promise<DesktopOverview> {
    const rows: DesktopOverview['usage']['rows'] = [];
    for (const meta of this.kernel.threads.listMetas(true)) {
      const runtime = this.kernel.threads.get(meta.id);
      let usage = runtime?.snapshotUsage() ?? meta.usage;
      if (!usage) {
        const event = [...(this.kernel.store.load(meta.id) ?? [])].reverse().find(event => event.t === 'usage');
        if (event?.t === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      }
      const inputTokens = Number.isFinite(usage?.inputTokens) ? Math.max(0, usage!.inputTokens) : 0;
      const outputTokens = Number.isFinite(usage?.outputTokens) ? Math.max(0, usage!.outputTokens) : 0;
      rows.push({ id: meta.id, title: meta.title, model: (meta.provider ? meta.provider + '/' : '') + meta.model, archived: !!meta.archived, updatedAt: meta.updatedAt, inputTokens, outputTokens, recorded: !!usage && inputTokens + outputTokens > 0, recovery: meta.recovery, running: !!runtime?.stateMachine.isRunning() });
      if (rows.length % 20 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    const runtimeFiles = ['icudtl.dat','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin'].map(name => ({ name, present: existsSync(join(dirname(process.execPath), name)) }));
    return { usage: { rows, conversations: rows.length, inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), unreported: rows.filter(row => !row.recorded).length }, diagnostics: { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, electron: process.versions.electron ?? '—', node: process.versions.node, keyStorage: safeStorage.isEncryptionAvailable() ? 'encrypted' : 'session', runtimeFiles, parserReady: existsSync(documentWorkerPath(__dirname)), skills: (await this.skills.list()).length } };
  }

  dispose(): void {
    this.lifecycle.splice(0).forEach(remove => remove());
    this.notifications.dispose();
    for (const channel of [
      'smalt:call',
      'smalt:approval:respond',
      'smalt:input:respond',
      'smalt:pick-folder',
      'smalt:settings:load',
      'smalt:settings:save',
      'smalt:settings:test', 'smalt:models:list', 'smalt:pick-files', 'smalt:file', 'smalt:window', 'smalt:context', 'smalt:activity',
      'smalt:skills', 'smalt:attachments:pick', 'smalt:attachments:image', 'smalt:attachments:preview', 'smalt:overview', 'smalt:diagnostics:export',
    ]) {
      ipcMain.removeHandler(channel);
    }
  }
}

/** keep only known keys with sane shapes; reject anything else */
function sanitizePatch(patch: Record<string, unknown>): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || JSON.stringify(patch).length > 100000) throw new Error('无效或过大的设置');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTING_KEYS.has(key)) continue;
    if (key === 'defaultProvider' || key === 'defaultModel') {
      if (typeof value === 'string') out[key] = value;
    } else if (key === 'permissions') {
      const p = (value ?? {}) as Record<string, unknown>;
      const perms: Record<string, unknown> = {};
      if (typeof p.mode === 'string' && MODES.has(p.mode)) perms.mode = p.mode;
      for (const list of ['allow', 'deny', 'ask'] as const) {
        if (Array.isArray(p[list])) {
          if (p[list].length > 200 || p[list].some(s => typeof s !== 'string' || s.length > 2000)) throw new Error('权限规则过多或无效');
          perms[list] = p[list];
        }
      }
      out.permissions = perms;
    } else if (key === 'providers') {
      const provs: Record<string, Record<string, unknown>> = {};
      for (const [name, cfg] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) throw new Error('服务商标识无效');
        if (typeof cfg !== 'object' || cfg === null) continue;
        const src = cfg as Record<string, unknown>;
        const keep: Record<string, unknown> = {};
        if (typeof src.apiKey === 'string') keep.apiKey = src.apiKey;
        if (typeof src.baseUrl === 'string') keep.baseUrl = src.baseUrl;
        if (typeof src.defaultModel === 'string') keep.defaultModel = src.defaultModel.trim();
        if (src.wire === 'chat' || src.wire === 'anthropic') keep.wire = src.wire;
        if (typeof src.contextWindow === 'number' && Number.isFinite(src.contextWindow) && src.contextWindow > 0) keep.contextWindow = src.contextWindow;
        if (src.contextWindow === null) keep.contextWindow = null;
        if (src.modelContextWindows && typeof src.modelContextWindows === 'object' && !Array.isArray(src.modelContextWindows)) {
          const entries = Object.entries(src.modelContextWindows);
          if (entries.length > 200 || entries.some(([id, window]) => !id || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id) || window !== null && !(typeof window === 'number' && Number.isSafeInteger(window) && window > 0))) throw new Error('模型上下文窗口无效');
          keep.modelContextWindows = Object.fromEntries(entries);
        }
        provs[name] = keep;
      }
      out.providers = provs;
    }
  }
  return out;
}
