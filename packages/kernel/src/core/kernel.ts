/**
 * Kernel assembly — wires every subsystem together and exposes:
 *   - `handle(method, params)`: the JSON-RPC method surface (transport-agnostic)
 *   - a ClientPort the host must provide (notifications + reverse requests)
 *
 * Embedding in-process (CLI) and running behind stdio JSON-RPC use the exact
 * same code path; only the port differs.
 */

import { resolve } from 'node:path';
import {
  loadSettings,
  resolveModelRef,
  type Settings,
} from '../config/settings.js';
import { HookBus, type HookEvent } from '../hooks/bus.js';
import { ModelGateway } from '../models/gateway.js';
import { parseRule, type PermissionRule } from '../permissions/rules.js';
import { PermissionService } from '../permissions/service.js';
import { JsonlThreadStore } from '../storage/jsonl.js';
import type { ThreadStore } from '../storage/thread-store.js';
import { ToolOrchestrator } from '../tools/orchestrator.js';
import { ToolRegistry } from '../tools/registry.js';
import { Compactor } from '../compact/compactor.js';
import { ContextPipeline, envInterceptor, systemInterceptor } from '../context/pipeline.js';
import { TurnRunner } from './turn-runner.js';
import { ThreadManager } from './thread-manager.js';
import type { ThreadRuntime } from './thread.js';
import { PERMISSION_MODES } from '../permissions/rules.js';
import { ProjectStore } from '../storage/projects.js';
import {
  Methods,
  type ApprovalDecision,
  type ApprovalRequest,
  type InitializeResult,
  type ThreadMeta,
  type UserInputRequest,
} from '../protocol/types.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { smaltHome } from '../config/settings.js';
import { CheckpointStore } from '../storage/checkpoints.js';
import { isInsideWorkspace } from '../tools/workspace-guard.js';

export interface ClientPort {
  notify(method: string, params?: unknown): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  askUser(req: UserInputRequest): Promise<string>;
  cancelApproval?(id: string): void;
}

export interface KernelOptions {
  cwd?: string;
  /** override loaded settings (tests, flags) */
  settings?: Settings;
  store?: ThreadStore;
  client: ClientPort;
  log?: (msg: string) => void;
}

const KERNEL_VERSION = '0.0.1';

export class Kernel {
  private settings: Settings;
  readonly gateway: ModelGateway;
  readonly hooks: HookBus;
  private permissions: PermissionService;
  readonly tools: ToolRegistry;
  readonly store: ThreadStore;
  readonly projects: ProjectStore;
  readonly checkpoints: CheckpointStore;
  readonly threads: ThreadManager;
  private readonly cwd: string;
  private readonly logFn: (msg: string) => void;
  private client: ClientPort;
  private settingsRevision = 0;
  private readonly explicitSettings: boolean;

  constructor(opts: KernelOptions) {
    this.cwd = resolve(opts.cwd ?? process.cwd());
    this.client = opts.client;
    this.logFn = opts.log ?? (() => {});
    this.settings = opts.settings ?? loadSettings(this.cwd);
    this.explicitSettings = !!opts.settings;
    this.store = opts.store ?? new JsonlThreadStore();
    this.projects = new ProjectStore();
    this.checkpoints = new CheckpointStore();
    this.hooks = new HookBus(this.logFn);
    this.hooks.setCommandHooks(this.settings.hooks as Partial<Record<HookEvent, never>> ?? {});
    this.gateway = new ModelGateway(this.settings);
    this.tools = new ToolRegistry();
    this.permissions = new PermissionService(
      this.settings.permissions.deny.map((r) => parseRule(r, 'user')),
      this.settings.permissions.allow.map((r) => parseRule(r, 'user')),
      this.settings.permissions.ask.map((r) => parseRule(r, 'user')),
    );
    this.permissions.setMode(this.settings.permissions.mode);

    const compactor = new Compactor(this.gateway, this.hooks, {
      ...this.settings.compact,
      contextWindow: this.gateway.contextWindowFor(resolveModelRef(undefined, this.settings)),
    });
    const pipeline = new ContextPipeline([envInterceptor(), systemInterceptor()]);
    const orchestrator = new ToolOrchestrator({
      checkpoints: this.checkpoints,
      tools: this.tools,
      permissions: this.permissions,
      hooks: this.hooks,
      requestApproval: (req) => this.client.requestApproval(req),
      askUser: (req) => this.client.askUser(req),
      onRememberAlways: (rule) => this.persistAllowRule(rule),
      log: this.logFn,
    });
    const runner = new TurnRunner({
      gateway: this.gateway,
      tools: this.tools,
      orchestrator,
      hooks: this.hooks,
      compactor,
      pipeline,
      store: this.store,
      notify: (method, params) => this.client.notify(method, params),
      log: this.logFn,
    });
    this.threads = new ThreadManager({
      store: this.store,
      runner,
      runnerFor: (rt) => this.runnerFor(rt),
      permissionsChanged: (rt) => this.updatePermissions(rt),
      settings: () => this.settings,
      contextWindowFor: (ref) => this.gateway.contextWindowFor(ref),
      notify: (method, params) => this.client.notify(method, params),
      log: this.logFn,
    });
  }

  /** Swap the client port (e.g. REPL takes over a kernel built elsewhere). */
  setClientPort(port: ClientPort): void {
    this.client = port;
  }

  getSettings(): Settings {
    return this.settings;
  }

  getPermissions(): PermissionService {
    return this.permissions;
  }

  /** Hot-reload settings (desktop settings panel, config file edits). */
  applySettings(next: Settings): void {
    this.settingsRevision++;
    this.settings = next;
    this.gateway.updateSettings(next);
    this.permissions = new PermissionService(
      next.permissions.deny.map((r) => parseRule(r, 'user')),
      next.permissions.allow.map((r) => parseRule(r, 'user')),
      next.permissions.ask.map((r) => parseRule(r, 'user')),
    );
    this.permissions.setMode(next.permissions.mode);
    this.hooks.setCommandHooks(next.hooks ?? {});
    for (const meta of this.threads.listMetas()) {
      const rt = this.threads.get(meta.id);
      if (rt?.permissions) this.updatePermissions(rt);
    }
  }

  private updatePermissions(rt: ThreadRuntime): void {
    const settings = loadSettings(rt.meta.cwd, { permissionMode: rt.meta.permissionMode ?? this.permissions.mode }, this.settings);
    const deny = settings.permissions.deny.map(r => parseRule(r, 'user'));
    const allow = settings.permissions.allow.map(r => parseRule(r, 'user'));
    const ask = settings.permissions.ask.map(r => parseRule(r, 'user'));
    if (!rt.permissions) rt.permissions = new PermissionService(deny, allow, ask);
    rt.permissions.reconfigure(deny, allow, ask, settings.permissions.mode);
    for (const category of rt.meta.approvedCategories ?? []) rt.permissions.allowCategory(category === 'edit' ? 'write' : category);
  }

  private runnerFor(rt: ThreadRuntime): TurnRunner {
    const requestedMode = rt.meta.permissionMode ?? this.permissions.mode;
    const settings = loadSettings(rt.meta.cwd, { permissionMode: requestedMode }, this.settings);
    const fingerprint = JSON.stringify({ settings, requestedMode });
    if (rt.runner && rt.settingsRevision === this.settingsRevision && rt.settingsFingerprint === fingerprint) return rt.runner;
    this.updatePermissions(rt);
    const permissions = rt.permissions!;
    const hooks = this.hooks.fork(settings.hooks ?? {});
    const gateway = this.gateway.fork(settings);
    const orchestrator = new ToolOrchestrator({
      checkpoints: this.checkpoints,
      tools: this.tools, permissions, hooks,
      requestApproval: (req) => this.client.requestApproval(req),
      cancelApproval: (id) => this.client.cancelApproval?.(id),
      onRememberCategory: (tool) => this.threads.rememberCategory(rt.meta.id, tool),
      askUser: (req) => this.client.askUser(req),
      onRememberAlways: (rule) => { this.persistAllowRule(rule); permissions.addSessionRule(rule); },
      onState: (_id, event) => rt.stateMachine.transition(event),
      onOutput: (threadId, itemId, delta) => this.client.notify('item/commandExecution/outputDelta', { threadId, itemId, delta }),
      log: this.logFn,
    });
    rt.runner = new TurnRunner({
      gateway, hooks, orchestrator, tools: this.tools, store: this.store,
      compactor: new Compactor(gateway, hooks, { ...settings.compact, contextWindow: gateway.contextWindowFor(rt.modelRef) }),
      pipeline: new ContextPipeline([envInterceptor(), systemInterceptor(), {
        name: 'project', priority: 1600,
        intercept: async ctx => {
          if (!rt.meta.projectId) return;
          const project = this.projects.require(rt.meta.projectId);
          ctx.prompt.unshift({ role: 'system', content: `User-selected project: ${project.name}\nProject instructions provided by the user:\n${project.instructions}` });
        },
      }]),
      notify: (method, params) => this.client.notify(method, params), log: this.logFn,
    });
    rt.settingsRevision = this.settingsRevision;
    rt.settingsFingerprint = fingerprint;
    return rt.runner;
  }

  /** JSON-RPC method surface. Throws RpcError-shaped Errors on failure. */
  async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, never>;
    switch (method) {
      case Methods.initialize:
        return this.initialize();

      case Methods.threadStart: {
        const projectId = p.projectId ? String(p.projectId) : undefined;
        const project = projectId ? this.projects.require(projectId) : undefined;
        const rt = this.threads.start({
          cwd: (p.cwd as unknown as string) ?? project?.cwd ?? this.cwd,
          model: p.model as unknown as string | undefined,
          title: p.title as unknown as string | undefined,
          permissionMode: this.validMode(p.permissionMode),
          projectId,
        });
        void this.hooks.emit('SessionStart', { threadId: rt.meta.id });
        return { threadId: rt.meta.id, meta: rt.meta };
      }

      case Methods.threadResume: {
        const rt = this.threads.resume(p.threadId as unknown as string);
        return { threadId: rt.meta.id, meta: rt.meta, items: rt.items };
      }

      case Methods.threadList:
        return { threads: this.threads.listMetas(Boolean(p.includeArchived)) };

      case Methods.threadRead: {
        const r = this.threads.read(p.threadId as unknown as string);
        return { meta: r.meta, items: r.items, status: this.threads.status(p.threadId as unknown as string) };
      }

      case Methods.threadArchive:
        this.checkpoints.assertAvailable(this.threads.read(String(p.threadId)).meta.cwd);
        return { archived: this.threads.archive(p.threadId as unknown as string) };
      case Methods.threadRestore:
        return { meta: this.threads.restore(String(p.threadId)) };
      case Methods.threadDelete: {
        const threadId = String(p.threadId);
        this.checkpoints.assertAvailable(this.threads.read(threadId).meta.cwd);
        const deleted = this.threads.delete(threadId);
        await this.checkpoints.delete(threadId);
        return { deleted };
      }
      case Methods.threadProject: {
        const projectId = p.projectId ? String(p.projectId) : null;
        if (projectId) this.projects.require(projectId);
        return { meta: this.threads.update(String(p.threadId), { projectId }) };
      }
      case Methods.projectList:
        return { projects: this.projects.list() };
      case Methods.projectCreate:
        return { project: this.projects.create({ name: String(p.name ?? ''), instructions: p.instructions, cwd: p.cwd }) };
      case Methods.projectUpdate:
        return { project: this.projects.update(String(p.projectId), { name: p.name, instructions: p.instructions, cwd: p.cwd }) };
      case Methods.projectDelete: {
        const projectId = String(p.projectId); this.projects.require(projectId);
        const conversations = this.threads.listMetas(true).filter(meta => meta.projectId === projectId);
        if (conversations.some(meta => this.threads.get(meta.id)?.stateMachine.isRunning())) throw new Error('Stop project tasks before deleting the project');
        for (const meta of conversations) this.threads.update(meta.id, { projectId: null });
        this.projects.delete(projectId);
        return { deleted: true };
      }

      case Methods.threadRename:
        return { meta: this.threads.update(String(p.threadId), { title: String(p.title ?? '') }) };
      case Methods.threadPin:
        return { meta: this.threads.update(String(p.threadId), { pinned: Boolean(p.pinned) }) };
      case Methods.threadSettings:
        return { meta: this.threads.update(String(p.threadId), { model: p.model, permissionMode: this.validMode(p.permissionMode) }) };
      case Methods.threadPermissionsReset:
        return { meta: this.threads.resetApprovals(String(p.threadId)) };

      case Methods.turnStart: {
        this.checkpoints.assertAvailable(this.threads.require(String(p.threadId)).meta.cwd);
        const outcome = await this.threads.runTurn(
          p.threadId as unknown as string,
          { text: String(p.input ?? ''), displayText: typeof p.displayText === 'string' ? p.displayText : undefined, references: this.userReferences(p.references) },
        );
        return outcome;
      }

      case Methods.turnSteer:
        this.checkpoints.assertAvailable(this.threads.require(String(p.threadId)).meta.cwd);
        return this.threads.steer(p.threadId as unknown as string, { text: String(p.message ?? ''), displayText: typeof p.displayText === 'string' ? p.displayText : undefined, references: this.userReferences(p.references) });

      case 'checkpoint/list': {
        const { meta } = this.threads.read(String(p.threadId));
        return { checkpoints: await this.checkpoints.list(meta.id, meta.cwd, p.checkpointId ? String(p.checkpointId) : undefined) };
      }
      case 'checkpoint/restore': {
        const { meta } = this.threads.read(String(p.threadId));
        const assertIdle = () => {
          for (const other of this.threads.listMetas(true)) {
            if ((isInsideWorkspace(meta.cwd, other.cwd) || isInsideWorkspace(other.cwd, meta.cwd)) && this.threads.get(other.id)?.stateMachine.isRunning()) throw new Error('请先停止此工作区中的运行任务，再恢复检查点');
          }
        };
        assertIdle();
        const result = await this.checkpoints.restore(meta.id, String(p.checkpointId), meta.cwd, p.paths as string[] | undefined, assertIdle);
        const note = '用户已从检查点恢复文件：' + result.restored.join('、') + '。文件系统已改变，后续编辑前必须重新读取文件。';
        const rt = this.threads.require(meta.id);
        const restoredAt = new Date().toISOString();
        rt.meta.restoredFiles = { ...rt.meta.restoredFiles, ...Object.fromEntries(result.restored.map(path => [path, restoredAt])) };
        if (result.operationId) rt.meta.restoredChanges = { ...rt.meta.restoredChanges, [result.operationId]: [...new Set([...(rt.meta.restoredChanges?.[result.operationId] ?? []), ...result.restored])] };
        this.store.append(meta.id, { t: 'meta', meta: { ...rt.meta } });
        this.client.notify('thread/updated', { threadId: meta.id, meta: { ...rt.meta } });
        rt.history.push({ role: 'user', content: note });
        this.store.append(meta.id, { t: 'user-msg', id: 'restore_' + Date.now(), text: note, at: new Date().toISOString() });
        this.client.notify('checkpoint/restored', { threadId: meta.id, paths: result.restored });
        return result;
      }

      case Methods.turnInterrupt:
        return { interrupted: this.threads.interrupt(p.threadId as unknown as string) };

      case Methods.threadCompact: {
        return this.threads.compact(String(p.threadId));
      }

      default:
        throw new Error(`method not found: ${method}`);
    }
  }

  private userReferences(value: unknown): import('../protocol/types.js').UserReference[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 10 || value.some(ref => !ref || typeof ref.path !== 'string' || ref.path.length > 4096 || (ref.label !== undefined && (typeof ref.label !== 'string' || ref.label.length > 4096)))) throw new Error('无效的文件引用');
    return value.map(ref => ({ path: ref.path, label: ref.label }));
  }

  private validMode(value: unknown): ThreadMeta['permissionMode'] {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(value)) throw new Error('Invalid permission mode');
    return value as ThreadMeta['permissionMode'];
  }

  private initialize(): InitializeResult {
    return {
      kernelInfo: { name: 'smalt-kernel', version: KERNEL_VERSION },
      capabilities: {
        approvals: true,
        userInput: true,
        steer: true,
        interrupt: true,
        compaction: true,
      },
      protocolVersion: 1,
    };
  }

  /** Write an "always allow" rule into the user settings file. */
  private persistAllowRule(rule: string): void {
    try {
      const file = join(smaltHome(), 'settings.json');
      let data: Record<string, unknown> = {};
      if (existsSync(file)) {
        data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } else {
        mkdirSync(smaltHome(), { recursive: true });
      }
      const perms = (data.permissions ?? {}) as Record<string, unknown>;
      const allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
      if (!allow.includes(rule)) {
        allow.push(rule);
        perms.allow = allow;
        data.permissions = perms;
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        appendFileSync(file, '\n', 'utf8');
      }
      // apply live
      if (!this.settings.permissions.allow.includes(rule)) this.applySettings({ ...this.settings, permissions: { ...this.settings.permissions, allow: [...this.settings.permissions.allow, rule] } });
    } catch (err) {
      this.logFn(`could not persist allow rule "${rule}": ${err instanceof Error ? err.message : err}`);
    }
  }

  currentModelMeta(): { provider: string; model: string } {
    const ref = resolveModelRef(undefined, this.settings);
    return ref;
  }

  listThreadsBrief(): Array<Pick<ThreadMeta, 'id' | 'title' | 'updatedAt'>> {
    return this.threads.listMetas().map((m) => ({ id: m.id, title: m.title, updatedAt: m.updatedAt }));
  }
}
