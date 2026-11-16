/**
 * Hook bus — lifecycle events everything can listen to.
 *
 * Event names follow the de-facto vocabulary shared by open-source coding
 * agents, so existing muscle memory and docs transfer directly.
 *
 * Hooks come in two flavours:
 *  - in-process handlers registered by kernel embedders/tests
 *  - command hooks from settings: `{"PreToolUse":[{"command":"node guard.js"}]}`
 *    the payload is piped to stdin as JSON; stdout may carry a JSON decision.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'ConfigChange'
  | 'Notification';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'ConfigChange',
  'Notification',
];

/** What a PreToolUse hook may decide. */
export interface HookDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  /** rewritten tool input (JSON value) — only meaningful for PreToolUse */
  modifiedInput?: unknown;
}

export type InProcessHook = (event: HookEvent, payload: unknown) => HookDecision | void | Promise<HookDecision | void>;

export interface CommandHookConfig {
  command: string;
  timeoutMs?: number;
}

export interface HookContext {
  tool?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface RegisteredHook {
  name?: string;
  fn: InProcessHook;
}

export class HookBus {
  private readonly emitter = new EventEmitter();
  private hooks: RegisteredHook[] = [];
  private commandHooks: Partial<Record<HookEvent, CommandHookConfig[]>> = {};

  constructor(private readonly log: (msg: string) => void = () => {}, private readonly parent?: HookBus, private readonly context: HookContext = {}) {
    this.emitter.setMaxListeners(100);
  }

  fork(config: Partial<Record<HookEvent, CommandHookConfig[]>>, context: HookContext = {}): HookBus {
    const bus = new HookBus(this.log, this, context);
    bus.setCommandHooks(config);
    return bus;
  }

  register(fn: InProcessHook, name?: string): () => void {
    const entry: RegisteredHook = { name, fn };
    this.hooks.push(entry);
    return () => {
      this.hooks = this.hooks.filter((h) => h !== entry);
    };
  }

  setCommandHooks(config: Partial<Record<HookEvent, CommandHookConfig[]>>): void {
    this.commandHooks = config;
  }

  /**
   * Fire an event and collect merged decisions.
   *
   * Merge policy: the STRICTEST decision wins (deny > ask > allow) so a later
   * hook can never silently override an earlier denial. When any hook fails
   * to execute (crash, spawn error, timeout), `anyFailed` is set — callers
   * treating hooks as security guards must degrade to `ask`, not pass through.
   */
  private allHooks(): RegisteredHook[] {
    return [...(this.parent ? this.parent.allHooks() : []), ...this.hooks];
  }

  private allCommandHooks(event: HookEvent): CommandHookConfig[] {
    const combined = [...(this.parent ? this.parent.allCommandHooks(event) : []), ...(this.commandHooks[event] ?? [])];
    const seen = new Set<string>();
    return combined.filter((cfg) => {
      const key = `${cfg.command}\0${cfg.timeoutMs ?? 10_000}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async emit(event: HookEvent, payload: HookContext): Promise<HookResult | null> {
    payload = { ...this.context, ...payload };
    let decision: HookResult | null = null;
    const markFailed = (why: string) => {
      this.log(`hook failed for ${event}: ${why}`);
      decision = decision
        ? { ...decision, anyFailed: true }
        : { decision: 'ask', reason: `a hook failed to execute (${why}); degrading to ask`, anyFailed: true };
    };

    for (const { fn, name } of this.allHooks()) {
      try {
        const result = await fn(event, payload);
        if (result) decision = mergeDecision(decision, result);
      } catch (err) {
        markFailed(`${name ?? '<anonymous>'}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const commands = this.allCommandHooks(event);
    if (commands.length) {
      for (const cfg of commands) {
        const out = await runCommandHook(cfg, event, payload);
        if (out === 'failed') {
          markFailed(`command hook "${cfg.command.slice(0, 60)}" crashed or timed out`);
        } else if (out) {
          decision = mergeDecision(decision, out);
        }
      }
    }

    let cur: HookBus | undefined = this;
    while (cur) {
      cur.emitter.emit(event, payload);
      cur = cur.parent;
    }
    return decision;
  }

  /** Plain observable subscription (no decisions). */
  on(event: HookEvent, listener: (payload: unknown) => void): void {
    this.emitter.on(event, listener as () => void);
  }
}

export interface HookResult extends HookDecision {
  /** true when at least one hook failed to execute */
  anyFailed: boolean;
}

function mergeDecision(base: HookResult | null, next: HookDecision): HookResult {
  const anyFailed = base?.anyFailed ?? false;
  if (!base) return { ...next, anyFailed };
  const strictest = strictness(next.decision) > strictness(base.decision) ? next.decision : base.decision;
  const strictestReason =
    strictness(next.decision) > strictness(base.decision) ? next.reason : base.reason;
  return {
    decision: strictest,
    reason: strictestReason ?? base.reason,
    modifiedInput: next.modifiedInput ?? base.modifiedInput,
    anyFailed,
  };
}

function strictness(decision: 'allow' | 'deny' | 'ask'): number {
  return decision === 'deny' ? 2 : decision === 'ask' ? 1 : 0;
}

async function runCommandHook(
  cfg: CommandHookConfig,
  event: HookEvent,
  payload: HookContext,
): Promise<HookDecision | 'failed' | null> {
  const isWin = process.platform === 'win32';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      isWin ? 'cmd.exe' : 'sh',
      isWin ? ['/d', '/s', '/c', cfg.command] : ['-c', cfg.command],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        windowsHide: true,
        detached: !isWin,
      },
    );
  } catch {
    return 'failed';
  }
  let timedOut = false;
  let forceResolve: ((code: number) => void) | undefined;
  const killHookTree = () => {
    timedOut = true;
    try {
      if (isWin && child.pid) {
        spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        child.kill('SIGKILL');
      }
    } catch { /* already exited */ }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    setTimeout(() => forceResolve?.(-1), 500).unref();
  };
  const timer = setTimeout(killHookTree, cfg.timeoutMs ?? 10_000);

  const stdoutChunks: Buffer[] = [];
  let bytes = 0;
  child.stdout?.on('data', (d: Buffer) => { bytes += d.length; if (bytes > 64 * 1024) killHookTree(); else stdoutChunks.push(d); });
  child.stderr?.on('data', () => {});
  child.stdin?.on('error', () => {});
  child.stdin?.end(JSON.stringify({ event, ...payload }));

  const code = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (c: number) => { if (!settled) { settled = true; resolve(c); } };
    forceResolve = finish;
    child.on('close', (c) => finish(c ?? 0));
    child.on('error', () => finish(-1));
  });
  clearTimeout(timer);
  if (timedOut || code !== 0) return 'failed';
  if (stdoutChunks.length === 0) return null;

  try {
    const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as Record<string, unknown>;
    const decision = parsed.decision;
    if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
      return {
        decision,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        modifiedInput: 'modifiedInput' in parsed ? parsed.modifiedInput : undefined,
      };
    }
  } catch {
    /* non-JSON output is fine — treat as observe-only */
  }
  return null;
}
