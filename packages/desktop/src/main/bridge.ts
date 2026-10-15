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
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Kernel,
  ensureProjectTrust,
  updateUserSettingsFile,
  isInsideWorkspace,
  isSensitivePath,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientPort,
  type UserInputRequest,
} from '@smalt/kernel';
import { isValidWorkspace } from './workspace.js';
import { readContextFile, resolveContext, searchContextFiles, type ContextReference } from './context-files.js';
import { DesktopNotifications } from './notifications.js';

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

  constructor(private readonly webContents: WebContents, private readonly pageURL: string) {
    this.notifications = new DesktopNotifications(webContents);
    const port: ClientPort = {
      notify: (method, params) => {
        this.send('smalt:notify', { method, params });
        const data = params as { threadId?: string; turnId?: string; interrupted?: boolean } | undefined;
        if (data?.threadId && (method === 'thread/deleted' || method === 'thread/archived')) this.notifications.resolveThread(data.threadId);
        if (data?.threadId && (method === 'turn/failed' || (method === 'turn/completed' && !data.interrupted))) {
          const title = this.kernel.threads.get(data.threadId)?.meta.title ?? '任务';
          this.notifications.show(data.threadId, data.threadId + ':' + method + ':' + data.turnId, method === 'turn/failed' ? '任务失败' : '任务已完成', title);
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
      client: port,
      log: (msg) => console.log(`[kernel] ${msg}`),
    });
    // getURL() is still empty during construction; the app loads exactly one
    // local page, so trust file:// frames and pin the origin once loaded
    this.restoreEncryptedKeys();
    this.registerHandlers();
    this.watchWindowLifecycle();
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
    this.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) failAll(); });
    this.webContents.on('render-process-gone', failAll);
    this.webContents.on('destroyed', failAll);
  }

  /** Decrypt apiKeyEnc entries from settings and inject them into the gateway. */
  private restoreEncryptedKeys(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    const providers = this.kernel.getSettings().providers as Record<
      string,
      { apiKeyEnc?: string; baseUrl?: string }
    >;
    for (const [name, cfg] of Object.entries(providers)) {
      if (!cfg?.apiKeyEnc) continue;
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
        }
      }
      if (['thread/resume', 'turn/start', 'turn/steer'].includes(method)) {
        const p = params as { threadId?: string };
        const { meta } = this.kernel.threads.read(String(p.threadId));
        const check = isValidWorkspace(meta.cwd);
        if (!check.ok) throw new Error(check.reason);
      }
      if (method === 'turn/interrupt') {
        const threadId = String((params as { threadId?: string })?.threadId);
        // Resolve reverse requests as well as aborting model/tool execution.
        for (const [id, pending] of this.pendingApprovals) {
          if (this.requestThreads.get(id) !== threadId) continue;
          pending({ decision: 'deny', reason: '任务已停止' }); this.pendingApprovals.delete(id);
          this.send('smalt:resolved', { id });
        }
        for (const [id, pending] of this.pendingInputs) {
          if (this.requestThreads.get(id) !== threadId) continue;
          pending(''); this.pendingInputs.delete(id); this.send('smalt:resolved', { id });
        }
      }
      return this.kernel.handle(method, params);
    });

    ipcMain.handle('smalt:approval:respond', (e, id: string, decision: ApprovalDecision) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      if (!decision || !['allow', 'deny'].includes(decision.decision) || ('remember' in decision && decision.remember && !['session', 'always'].includes(decision.remember)) || ('scope' in decision && decision.scope && !['operation', 'category', 'batch'].includes(decision.scope))) throw new Error('Invalid approval response');
      this.pendingApprovals.get(id)?.(decision);
      this.pendingApprovals.delete(id);
    });

    ipcMain.handle('smalt:input:respond', (e, id: string, text: string) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
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
      return { canceled: false as const, dir };
    });

    ipcMain.handle('smalt:pick-files', async (e) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const result = await dialog.showOpenDialog({ title: '添加文件引用', properties: ['openFile', 'multiSelections'] });
      return result.canceled ? [] : result.filePaths.filter(p => !isSensitivePath(app.getPath('home'), p)).slice(0, 10);
    });
    ipcMain.handle('smalt:context', async (e, cwd: string, action: string, value: unknown) => {
      if (!this.trusted(e) || typeof cwd !== 'string') throw new Error('untrusted request');
      if (action === 'search' && typeof value === 'string' && value.length <= 300) return searchContextFiles(cwd, value);
      if (action === 'resolve') return resolveContext(cwd, value as ContextReference[]);
      throw new Error('无效的上下文操作');
    });
    ipcMain.handle('smalt:activity', (e, threadId: string | null, enabled: boolean) => {
      if (!this.trusted(e) || (threadId !== null && typeof threadId !== 'string') || typeof enabled !== 'boolean') throw new Error('untrusted request');
      this.notifications.configure(threadId, enabled);
    });
    ipcMain.handle('smalt:file', async (e, threadId: string, path: string, action: string) => {
      if (!this.trusted(e) || typeof path !== 'string') throw new Error('untrusted request');
      const cwd = this.kernel.threads.read(threadId).meta.cwd;
      if (!isInsideWorkspace(cwd, path) || isSensitivePath(cwd, path)) throw new Error('文件超出工作区或属于敏感路径');
      const target = resolve(cwd, path);
      if (action === 'reveal') { shell.showItemInFolder(target); return { ok: true }; }
      if (action !== 'read') throw new Error('Invalid file action');
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error('只能预览文件');
      if (stat.size > 512 * 1024) return { binary: true, size: stat.size, text: '', reason: '文件较大，请在资源管理器中查看' };
      try { return await readContextFile(cwd, path); }
      catch { return { binary: true, size: stat.size, text: '', reason: '此格式无法作为 UTF-8 文本预览' }; }
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
              hasKey:
                Boolean(this.kernel.gateway.providerConfig(name).apiKey) ||
                Boolean(cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) ||
                Boolean(cfg.apiKey),
              defaultModel: cfg.defaultModel,
            },
          ]),
        ),
        keyStorage: safeStorage.isEncryptionAvailable() ? 'encrypted' : 'session',
        effective: {
          defaultProvider: settings.defaultProvider,
          defaultModel: settings.defaultModel,
          permissionMode: settings.permissions.mode,
        },
      };
    });

    ipcMain.handle('smalt:settings:save', (e, patch: Record<string, unknown>) => {
      if (!this.trusted(e)) throw new Error('untrusted sender');
      const clean = sanitizePatch(patch);
      // hoist plaintext API keys into safeStorage-encrypted apiKeyEnc
      const providers = clean.providers as Record<string, { apiKey?: string; apiKeyEnc?: string }> | undefined;
      if (providers) {
        for (const [name, cfg] of Object.entries(providers)) {
          if (typeof cfg?.apiKey !== 'string' || !cfg.apiKey) continue;
          const plain = cfg.apiKey;
          // Null removes an old plaintext entry when merging the user file.
          (cfg as Record<string, unknown>).apiKey = null;
          if (safeStorage.isEncryptionAvailable()) {
            cfg.apiKeyEnc = safeStorage.encryptString(plain).toString('base64');
            this.kernel.gateway.overrideProvider(name, { apiKey: plain });
          } else {
            // no OS keychain support: keep the key for this session only
            this.kernel.gateway.overrideProvider(name, { apiKey: plain });
          }
        }
      }
      const next = updateUserSettingsFile(app.getPath('home'), clean);
      this.kernel.applySettings(next);
      this.restoreEncryptedKeys();
      return { ok: true };
    });
    ipcMain.handle('smalt:settings:test', async (e, provider: string, model: string) => {
      if (!this.trusted(e) || !this.kernel.getSettings().providers[provider] || typeof model !== 'string' || !model.trim()) throw new Error('Invalid provider or model');
      const signal = AbortSignal.timeout(15_000);
      for await (const _delta of this.kernel.gateway.stream({ provider, model }, { messages: [{ role: 'user', content: 'Reply OK.' }], tools: [], maxOutputTokens: 8, signal })) { /* verify real response */ }
      return { ok: true };
    });
  }

  private encState(): Record<string, boolean> {
    const state: Record<string, boolean> = {};
    const providers = this.kernel.getSettings().providers as Record<string, { apiKeyEnc?: string }>;
    for (const [name, cfg] of Object.entries(providers)) {
      state[name] = Boolean(cfg?.apiKeyEnc);
    }
    return state;
  }

  dispose(): void {
    this.notifications.dispose();
    for (const channel of [
      'smalt:call',
      'smalt:approval:respond',
      'smalt:input:respond',
      'smalt:pick-folder',
      'smalt:settings:load',
      'smalt:settings:save',
      'smalt:settings:test', 'smalt:pick-files', 'smalt:file', 'smalt:window', 'smalt:context', 'smalt:activity',
    ]) {
      ipcMain.removeHandler(channel);
    }
  }
}

/** keep only known keys with sane shapes; reject anything else */
function sanitizePatch(patch: Record<string, unknown>): Record<string, unknown> {
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
          perms[list] = (p[list] as unknown[]).filter((s): s is string => typeof s === 'string');
        }
      }
      out.permissions = perms;
    } else if (key === 'providers') {
      const provs: Record<string, Record<string, unknown>> = {};
      for (const [name, cfg] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        if (typeof cfg !== 'object' || cfg === null) continue;
        const src = cfg as Record<string, unknown>;
        const keep: Record<string, unknown> = {};
        if (typeof src.apiKey === 'string') keep.apiKey = src.apiKey;
        if (typeof src.baseUrl === 'string') keep.baseUrl = src.baseUrl;
        if (typeof src.defaultModel === 'string') keep.defaultModel = src.defaultModel.trim();
        if (src.wire === 'chat' || src.wire === 'anthropic') keep.wire = src.wire;
        if (typeof src.apiKeyEnv === 'string') keep.apiKeyEnv = src.apiKeyEnv;
        if (typeof src.contextWindow === 'number' && Number.isFinite(src.contextWindow) && src.contextWindow > 0) keep.contextWindow = src.contextWindow;
        provs[name] = keep;
      }
      out.providers = provs;
    }
  }
  return out;
}
