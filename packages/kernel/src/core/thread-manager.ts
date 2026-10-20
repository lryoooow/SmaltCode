/**
 * ThreadManager — owns thread runtimes, persistence, and the single-flight
 * run discipline: exactly one turn per thread at a time. New user input that
 * arrives mid-turn is queued and drained automatically when the machine
 * returns to idle via a drain-eligible event (AGENT_ENDED, RUN_FAILED, …).
 */

import { resolveModelRef, type ModelRef, type Settings } from '../config/settings.js';
import { TurnRunner } from './turn-runner.js';
import { ThreadRuntime } from './thread.js';
import { newId, nowIso } from '../util.js';
import { replayEvents, type ReplayedThread, type StoreEvent, type ThreadStore } from '../storage/thread-store.js';
import { Notifications, type Item, type ThreadMeta, type ThreadStatus } from '../protocol/types.js';
import { toolClass } from '../permissions/rules.js';
import { displayCommand, itemAssessment } from '../protocol/assessment.js';

export interface ThreadManagerDeps {
  store: ThreadStore;
  runner: TurnRunner;
  runnerFor?: (rt: ThreadRuntime) => TurnRunner;
  permissionsChanged?: (rt: ThreadRuntime) => void;
  settings: () => Settings;
  contextWindowFor(ref: ModelRef): number;
  notify(method: string, params?: unknown): void;
  log(msg: string): void;
}

export class ThreadManager {
  private readonly runtimes = new Map<string, ThreadRuntime>();
  /** serialized turn execution per thread */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ThreadManagerDeps) {}

  start(opts: { cwd: string; model?: string; title?: string; permissionMode?: ThreadMeta['permissionMode']; projectId?: string }): ThreadRuntime {
    const settings = this.deps.settings();
    const modelRef = resolveModelRef(opts.model, settings);
    const meta: ThreadMeta = {
      id: newId('th'),
      title: opts.title?.slice(0, 120) || 'New thread',
      model: modelRef.model,
      provider: modelRef.provider,
      cwd: opts.cwd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      turnCount: 0,
      permissionMode: opts.permissionMode,
      projectId: opts.projectId,
    };
    this.deps.store.append(meta.id, { t: 'meta', meta });
    const runtime = new ThreadRuntime(meta, modelRef, []);
    this.runtimes.set(meta.id, runtime);
    this.watchStatus(runtime);
    this.deps.notify(Notifications.threadStarted, { threadId: meta.id, meta });
    return runtime;
  }

  resume(threadId: string): ThreadRuntime {
    const existing = this.runtimes.get(threadId);
    if (existing) return existing;

    const events = this.deps.store.load(threadId);
    if (!events) throw new Error(`thread not found: ${threadId}`);

    const meta = latestMeta(events);
    if (!meta) throw new Error(`thread ${threadId} has no metadata (corrupt file?)`);
    const replayed: Pick<ReplayedThread, 'history' | 'lastUsage'> = replayEvents(events);
    const settings = this.deps.settings();
    const modelRef = resolveModelRef(meta.model, settings);
    // prefer stored provider when it exists
    if (meta.provider && settings.providers[meta.provider]) {
      modelRef.provider = meta.provider;
    }
    const runtime = new ThreadRuntime(meta, modelRef, replayed.history);
    runtime.usage = { ...replayed.lastUsage };
    runtime.items = replayItems(events, threadId);
    runtime.summaries = events.flatMap(event => event.t === 'turn-ended' && event.summary ? [{ ...event.summary, turnId: event.turnId }] : []);
    const lastTurn = events.findLast(event => event.t === 'turn-started');
    const notice = events.findLast(event => event.t === 'context-notice' && event.notice.turnId === (lastTurn?.t === 'turn-started' ? lastTurn.turnId : ''));
    if (notice?.t === 'context-notice') runtime.contextNotice = notice.notice;
    const ended = events.findLast(event => event.t === 'turn-ended');
    if (meta.lastOutcome === 'failed' && ended?.t === 'turn-ended') meta.lastError ??= ended.error;
    this.runtimes.set(threadId, runtime);
    this.watchStatus(runtime);
    return runtime;
  }

  get(threadId: string): ThreadRuntime | undefined {
    return this.runtimes.get(threadId);
  }

  require(threadId: string): ThreadRuntime {
    const rt = this.get(threadId);
    if (!rt) throw new Error(`thread not loaded: ${threadId} (call thread/resume first)`);
    return rt;
  }

  listMetas(includeArchived = false): ThreadMeta[] {
    return this.deps.store.listMetas(includeArchived);
  }

  /** Recover persisted unfinished turns once at host startup; never rerun tools. */
  recoverInterrupted(): void {
    for (const meta of this.deps.store.listMetas(true)) {
      if (this.get(meta.id)?.stateMachine.isRunning()) continue;
      if (this.deps.store.hasInterruptedTurn?.(meta.id) === false) continue;
      const events = this.deps.store.load(meta.id) ?? [];
      const latest = [...events].reverse().find(event => event.t === 'turn-started');
      if (!latest || latest.t !== 'turn-started' || events.some(event => event.t === 'turn-ended' && event.turnId === latest.turnId)) continue;
      const start = events.lastIndexOf(latest);
      const results = new Set(events.slice(start).filter(event => event.t === 'tool-result').map(event => event.id));
      for (const event of events.slice(start)) {
        if (event.t !== 'tool-call' || results.has(event.id)) continue;
        this.deps.store.append(meta.id, { t: 'tool-result', id: event.id, tool: event.tool, output: '上次任务未完整结束，该操作的结果未保存。继续前请检查实际文件和进程状态，避免重复操作。', isError: true, at: nowIso() });
      }
      this.deps.store.append(meta.id, { t: 'turn-ended', turnId: latest.turnId, at: nowIso(), interrupted: true });
      this.deps.store.append(meta.id, { t: 'meta', meta: { ...meta, lastOutcome: 'interrupted', recovery: { turnId: latest.turnId, startedAt: latest.at } } });
    }
  }

  read(threadId: string): { meta: ThreadMeta; items: Item[]; summaries: import('../protocol/types.js').TurnSummary[]; contextNotice?: import('../protocol/types.js').ContextNotice } {
    const rt = this.get(threadId) ?? this.resume(threadId);
    return { meta: rt.meta, items: rt.items, summaries: rt.summaries, contextNotice: rt.contextNotice };
  }

  status(threadId: string): ThreadStatus {
    const rt = this.require(threadId);
    return {
      threadId,
      lifecycle: rt.stateMachine.lifecycle,
      state: rt.stateMachine.current,
      queuedMessages: rt.steerQueue.length + rt.turnQueue.length,
    };
  }

  archive(threadId: string): boolean {
    const rt = this.get(threadId);
    if (rt?.stateMachine.isRunning()) throw new Error('Stop the running task before archiving it');
    if (this.chains.has(threadId)) throw new Error('Wait for the task to finish before archiving it');
    const archived = this.deps.store.archive(threadId) ?? false;
    this.runtimes.delete(threadId);
    this.deps.notify('thread/archived', { threadId });
    return archived;
  }

  restore(threadId: string): ThreadMeta {
    if (!this.deps.store.restore?.(threadId)) throw new Error('Archived conversation not found');
    this.runtimes.delete(threadId);
    const meta = this.resume(threadId).meta;
    this.deps.notify('thread/updated', { threadId, meta: { ...meta } });
    return meta;
  }

  delete(threadId: string): boolean {
    if (this.get(threadId)?.stateMachine.isRunning() || this.chains.has(threadId)) throw new Error('Stop the task before deleting it');
    const deleted = this.deps.store.delete?.(threadId) ?? false;
    this.runtimes.delete(threadId);
    this.deps.notify('thread/deleted', { threadId });
    return deleted;
  }

  update(threadId: string, patch: { title?: string; pinned?: boolean; model?: string; permissionMode?: ThreadMeta['permissionMode']; projectId?: string | null }): ThreadMeta {
    const rt = this.get(threadId) ?? this.resume(threadId);
    if (rt.stateMachine.isRunning() && patch.model) throw new Error('Stop the task before changing its model');
    if (rt.stateMachine.isRunning() && patch.projectId !== undefined) throw new Error('Stop the task before moving it to another project');
    if (patch.title !== undefined) {
      const title = patch.title.trim().slice(0, 120);
      if (!title) throw new Error('Title cannot be empty');
      rt.meta.title = title;
    }
    if (typeof patch.pinned === 'boolean') rt.meta.pinned = patch.pinned;
    if (patch.model) {
      const ref = resolveModelRef(patch.model, this.deps.settings());
      Object.assign(rt.modelRef, ref);
      rt.meta.model = ref.model;
      rt.meta.provider = ref.provider;
    }
    if (patch.permissionMode) { rt.meta.permissionMode = patch.permissionMode; this.deps.permissionsChanged?.(rt); }
    if (patch.projectId !== undefined) rt.meta.projectId = patch.projectId ?? undefined;
    if (!rt.stateMachine.isRunning()) rt.runner = undefined;
    rt.meta.updatedAt = nowIso();
    this.deps.store.append(threadId, { t: 'meta', meta: { ...rt.meta } });
    this.deps.notify('thread/updated', { threadId, meta: { ...rt.meta } });
    return rt.meta;
  }

  private watchStatus(rt: ThreadRuntime): void {
    rt.stateMachine.onChange = () => this.deps.notify(Notifications.threadStatusChanged, this.status(rt.meta.id));
  }

  rememberCategory(threadId: string, tool: string): void {
    const rt = this.require(threadId); const category = toolClass(tool);
    if (category === 'other') return;
    rt.meta.approvedCategories = [...new Set([...(rt.meta.approvedCategories ?? []), category])];
    this.deps.store.append(threadId, { t: 'meta', meta: { ...rt.meta } });
    this.deps.notify('thread/updated', { threadId, meta: { ...rt.meta } });
  }

  resetApprovals(threadId: string): ThreadMeta {
    const rt = this.get(threadId) ?? this.resume(threadId);
    rt.meta.approvedCategories = undefined;
    rt.permissions?.resetSessionRules();
    this.deps.store.append(threadId, { t: 'meta', meta: { ...rt.meta } });
    this.deps.notify('thread/updated', { threadId, meta: { ...rt.meta } });
    return rt.meta;
  }

  /** Start a turn. If one is running, the input is queued and drained later. */
  runTurn(threadId: string, input: import('../protocol/types.js').UserPrompt): Promise<import('./turn-runner.js').TurnOutcome> {
    const rt = this.require(threadId);
    if (rt.meta.archived) throw new Error('Restore the archived conversation before continuing it');
    if (rt.stateMachine.isRunning() || this.chains.has(threadId)) {
      rt.turnQueue.push(input);
      this.deps.log(`thread ${threadId} busy — queued input (${rt.turnQueue.length} waiting)`);
      return Promise.resolve({
        turnId: 'queued',
        interrupted: false,
        failed: false,
        assistantText: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'queued behind a running turn',
      });
    }
    return this.enqueueTurn(rt, input);
  }

  /** Steer a running turn; when idle it behaves like starting a new turn. */
  steer(threadId: string, message: import('../protocol/types.js').UserPrompt): { queued: boolean } {
    const rt = this.require(threadId);
    if (rt.meta.archived) throw new Error('Restore the archived conversation before continuing it');
    if (rt.stateMachine.isRunning()) {
      rt.steerQueue.push(message);
      return { queued: true };
    }
    void this.enqueueTurn(rt, message);
    return { queued: false };
  }

  interrupt(threadId: string): boolean {
    const rt = this.require(threadId);
    if (!rt.stateMachine.isRunning()) return false;
    rt.stateMachine.transition('CANCEL_REQUESTED');
    rt.abort?.abort();
    rt.turnQueue.length = 0;
    rt.steerQueue.length = 0;
    return true;
  }

  private enqueueTurn(rt: ThreadRuntime, input: import('../protocol/types.js').UserPrompt): Promise<import('./turn-runner.js').TurnOutcome> {
    const run = () => {
      const controller = new AbortController();
      rt.abort = controller;
      rt.contextNotice = undefined;
      rt.stateMachine.transition('RUN_PREPARING');
      if (rt.meta.recovery) { delete rt.meta.recovery; this.deps.store.append(rt.meta.id, { t: 'meta', meta: { ...rt.meta } }); }
      return (this.deps.runnerFor?.(rt) ?? this.deps.runner)
        .runTurn(rt.stateMachine, this.runtimeAdapter(rt), input)
        .then((outcome) => {
          if (outcome.summary) rt.summaries.push({ ...outcome.summary, turnId: outcome.turnId });
          rt.meta.turnCount++;
          rt.meta.updatedAt = nowIso();
          rt.meta.lastOutcome = outcome.failed ? 'failed' : outcome.interrupted ? 'interrupted' : 'completed';
          rt.meta.lastError = outcome.failed ? outcome.error : undefined;
          rt.meta.lastAssessment = outcome.summary?.assessment;
          rt.meta.usage = rt.snapshotUsage();
          this.deps.store.append(rt.meta.id, { t: 'meta', meta: { ...rt.meta } });
          this.deps.notify('thread/updated', { threadId: rt.meta.id, meta: { ...rt.meta } });
          rt.notifyUsagePersisted();
          return outcome;
        })
        .finally(() => {
          if (rt.abort === controller) rt.abort = null;
          if (this.chains.get(rt.meta.id) === next) this.chains.delete(rt.meta.id);
          this.drainIfIdle(rt);
        });
    };

    const prev = this.chains.get(rt.meta.id) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.chains.set(rt.meta.id, next);
    return next;
  }

  async compact(threadId: string): Promise<{ compacted: boolean; reason?: string }> {
    const rt = this.require(threadId);
    if (rt.stateMachine.isRunning()) throw new Error('Stop the task before compacting');
    rt.abort = new AbortController();
    try { return await (this.deps.runnerFor?.(rt) ?? this.deps.runner).compact(rt.stateMachine, this.runtimeAdapter(rt)); }
    finally { rt.abort = null; }
  }

  /** Drain the queued inputs when the machine came to rest "naturally". */
  private drainIfIdle(rt: ThreadRuntime): void {
    if (rt.stateMachine.isRunning()) return;
    const next = rt.turnQueue.shift();
    if (next === undefined) return;
    this.deps.log(`draining queued input for thread ${rt.meta.id}`);
    void this.enqueueTurn(rt, next).catch((err) =>
      this.deps.log(`drained turn failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  private runtimeAdapter(rt: ThreadRuntime) {
    return {
      threadId: rt.meta.id,
      cwd: rt.meta.cwd,
      modelRef: rt.modelRef,
      history: rt.history,
      items: rt.items,
      steerQueue: rt.steerQueue,
      signal: rt.abort!.signal,
      onHistoryReplaced: (history: import('../models/types.js').ChatMessage[]) => {
        rt.history = history;
      },
      onContextNotice: (notice: import('../protocol/types.js').ContextNotice) => { rt.contextNotice = notice; },
      addUsage: (i: number, o: number) => rt.addUsage(i, o),
      usageTotals: () => rt.snapshotUsage(),
      contextWindow: () => rt.runner?.contextWindow ?? this.deps.contextWindowFor(rt.modelRef),
    };
  }
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const parts: string[] = [];
  for (const v of Object.values(input).slice(0, 2)) {
    parts.push(typeof v === 'string' ? v.slice(0, 80) : '');
  }
  return parts.filter(Boolean).length ? ` ${parts.filter(Boolean).join(' ')}` : '';
}

function fileChangePath(id: string, input: unknown): string {
  const obj = input as Record<string, unknown> | undefined;
  if (obj && typeof obj.path === 'string') return obj.path;
  if (obj && typeof obj.patch === 'string') {
    const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(obj.patch);
    if (m) return m[1]!.trim();
  }
  return id;
}

function fileChangeKind(output: string): 'add' | 'update' | 'delete' {
  if (/^Created /m.test(output)) return 'add';
  if (output.includes('delete')) return 'delete';
  return 'update';
}

function latestMeta(events: StoreEvent[]): ThreadMeta | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.t === 'meta') return ev.meta;
  }
  return null;
}

function replayItems(events: StoreEvent[], threadId: string): Item[] {
  const items: Item[] = [];
  const toolInputs = new Map<string, unknown>();
  let turnId = 'unknown';
  for (const [eventIndex, ev] of events.entries()) {
    const at = 'at' in ev ? ev.at : nowIso();
    switch (ev.t) {
      case 'turn-started':
        turnId = ev.turnId;
        break;
      case 'user-msg':
        items.push({ kind: 'userMessage', id: ev.id, threadId, turnId, createdAt: at, status: 'completed', text: ev.displayText ?? ev.text, references: ev.references });
        break;
      case 'agent-msg':
        items.push({ kind: 'agentMessage', id: ev.id, threadId, turnId, createdAt: at, status: ev.status ?? 'completed', text: ev.text });
        break;
      case 'reasoning':
        items.push({ kind: 'reasoning', id: ev.id, threadId, turnId, createdAt: at, status: ev.status ?? 'completed', text: ev.text });
        break;
      case 'tool-call':
        toolInputs.set(ev.id, ev.input);
        break; // paired with its tool-result below
      case 'tool-result': {
        if (ev.items) { items.push(...ev.items); break; }
        const kind = ev.tool === 'write' || ev.tool === 'apply_patch' ? 'fileChange' : 'commandExecution';
        if (kind === 'fileChange') {
          items.push({ kind: 'fileChange', id: ev.id, threadId, turnId, createdAt: at, status: ev.isError ? 'failed' : 'completed', path: fileChangePath(ev.id, toolInputs.get(ev.id)), changeKind: fileChangeKind(ev.output), diff: ev.output.slice(0, 2000) });
        } else {
          const input = toolInputs.get(ev.id) as Record<string, unknown> | undefined;
          const command = ev.tool === 'shell' ? displayCommand(input ?? {}) : `${ev.tool}${summarizeToolInput(input)}`;
          const code = ev.output.match(/^\[exit (-?\d+)\]/);
          items.push({ kind: 'commandExecution', id: ev.id, threadId, turnId, createdAt: at, status: ev.isError ? 'failed' : 'completed', command, tool: ev.tool, exitCode: code ? Number(code[1]) : ev.tool === 'shell' ? null : ev.isError ? 1 : 0, output: ev.output });
        }
        break;
      }
      case 'plan':
        items.push({ kind: 'plan', id: ev.id ?? `plan_${turnId}_${eventIndex}_${at}`, threadId, turnId, createdAt: at, status: 'completed', steps: ev.steps });
        break;
      case 'tool-recovered': {
        const prior = items.find(i => i.id === ev.id && i.turnId === turnId);
        if (prior?.kind === 'commandExecution') {
          const assessment = itemAssessment(prior);
          if (assessment) prior.assessment = { ...assessment, recoveredBy: ev.recoveredBy, recovery: ev.recovery ?? 'alternative' };
        }
        break;
      }
      default:
        break;
    }
  }
  return items;
}
