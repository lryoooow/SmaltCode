/**
 * ToolOrchestrator — the governance chain wrapped around every tool run:
 *
 *   PreToolUse hooks → permission chain → (reverse-RPC approval if needed)
 *   → execute with streaming → PostToolUse(Failure) hooks
 *
 * Denials are *results*, not exceptions: the reason goes back to the model as
 * a tool result so it can adjust and continue the turn.
 *
 * If a PreToolUse hook failed to execute, the call degrades to `ask` — a
 * broken guard must fail closed, not open.
 */

import type { HookBus } from '../hooks/bus.js';
import type { ApprovalDecision, ApprovalRequest, UserInputRequest } from '../protocol/types.js';
import type { PermissionService } from '../permissions/service.js';
import { resolve } from 'node:path';
import { newId } from '../util.js';
import type { ToolRegistry } from './registry.js';
import type { ToolDefinition, ToolEvent, ToolRunContext } from './types.js';
import { validateInput } from './types.js';
import { isInsideWorkspace, isSensitivePath } from './workspace-guard.js';
import { toolClass } from '../permissions/rules.js';
import type { CheckpointStore } from '../storage/checkpoints.js';

export interface OrchestratorDeps {
  checkpoints?: CheckpointStore;
  tools: ToolRegistry;
  permissions: PermissionService;
  hooks: HookBus;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  cancelApproval?: (id: string) => void;
  askUser(req: UserInputRequest): Promise<string>;
  /** persist an "always allow" rule chosen during approval */
  onRememberAlways?: (rule: string) => void;
  onRememberCategory?: (tool: string) => void;
  log(msg: string): void;
  onState?: (threadId: string, event: import('../core/state-machine.js').RunEvent) => void;
  onOutput?: (threadId: string, itemId: string, delta: string) => void;
}

export interface ToolRunOutcome {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  denied: boolean;
  /** transient output for streaming display */
  deltas: string[];
  /** item payloads emitted by the tool (plans, prompts) */
  emittedItems: Array<{ kind: string; payload: unknown }>;
}

export class ToolOrchestrator {
  private readonly batches = new Map<string, Map<string, string>>();
  constructor(private readonly deps: OrchestratorDeps) {}
  endBatch(id: string): void { this.batches.delete(id); }

  /** read-type tools targeting outside the workspace (downgraded to ask) */
  private readsOutsideWorkspace(toolName: string, input: unknown, cwd: string): boolean {
    if (toolName !== 'read' && toolName !== 'grep' && toolName !== 'glob') return false;
    const raw = input as Record<string, unknown>;
    const targetPath = typeof raw.path === 'string' && raw.path ? raw.path : '.';
    return !isInsideWorkspace(cwd, targetPath);
  }

  /** hard boundary verdict for write/edit tools; null means "pass" */
  private boundaryViolation(
    toolName: string,
    input: unknown,
    cwd: string,
  ): { reason: string; message: string } | null {
    const tool = this.deps.tools.get(toolName);
    if (!tool) return null;
    if (toolName === 'write' || toolName === 'apply_patch') {
      const targets = tool.subjects?.(input) ?? [tool.subject(input)];
      const sensitive = targets.find((t) => isSensitivePath(cwd, t));
      if (sensitive) {
        return {
          reason: `sensitive path: ${sensitive}`,
          message: `Cannot ${toolName} "${sensitive}": this location holds agent configuration, project hooks, or OS credentials and is never writable by tools.`,
        };
      }
      const escapee = targets.find((t) => !isInsideWorkspace(cwd, t));
      if (escapee) {
        return {
          reason: `path escapes the workspace: ${escapee}`,
          message: `Cannot ${toolName} "${escapee}": file edits are limited to the workspace (${cwd}). Restart the agent with the target directory as cwd if this is intentional.`,
        };
      }
      return null;
    }
    if (toolName === 'read' || toolName === 'grep' || toolName === 'glob') {
      const raw = input as Record<string, unknown>;
      const targetPath = typeof raw.path === 'string' && raw.path ? raw.path : '.';
      // glob patterns can smuggle a path prefix like `../outside/**`
      const patternPrefix =
        toolName === 'glob' && typeof raw.pattern === 'string' && raw.pattern.includes('..')
          ? resolve(cwd, String(raw.pattern).split('*')[0]!.replace(/\/[^/]*$/, '') || '.')
          : null;
      const sensitive =
        isSensitivePath(cwd, targetPath) || (patternPrefix && isSensitivePath(cwd, patternPrefix));
      if (sensitive) {
        return {
          reason: `sensitive path: ${targetPath}`,
          message: `Cannot ${toolName} "${targetPath}": credential/config directories are off-limits to the agent.`,
        };
      }
    }
    return null;
  }

  async execute(
    toolCallId: string,
    toolName: string,
    rawInput: unknown,
    baseCtx: Omit<ToolRunContext, 'emitItem' | 'askUser'>,
  ): Promise<ToolRunOutcome> {
    const outcome: ToolRunOutcome = {
      toolCallId,
      toolName,
      output: '',
      isError: false,
      denied: false,
      deltas: [],
      emittedItems: [],
    };

    const tool = this.deps.tools.get(toolName);
    if (!tool) {
      return this.finish(outcome, `Error: unknown tool "${toolName}"`, true);
    }

    const validated = validateInput(tool.inputSchema, rawInput);
    if (!validated.ok) {
      return this.finish(outcome, `Error: invalid input for ${toolName}: ${validated.error}`, true);
    }
    let input: unknown = validated.value;

    // 0. HARD BOUNDARIES (before rules or hooks get a say) — re-checked
    //    after a PreToolUse hook rewrites the input, so hooks cannot smuggle
    //    a target past the boundary:
    //    a) file WRITES stay inside the workspace — in every mode, symlink-safe
    //    b) nothing touches agent config / OS credentials / project hooks
    //    c) file READS outside the workspace are downgraded to an approval
    let readOutsideWorkspace = this.readsOutsideWorkspace(toolName, input, baseCtx.cwd);
    const violation = this.boundaryViolation(toolName, input, baseCtx.cwd);
    if (violation) {
      await this.deps.hooks.emit('PostToolUseFailure', {
        tool: toolName,
        reason: violation.reason,
      });
      return this.finish(outcome, violation.message, true, true);
    }

    // 1. PreToolUse hooks may allow/deny/ask or rewrite the input
    const hookResult = await this.deps.hooks.emit('PreToolUse', { tool: toolName, input });
    if (hookResult?.modifiedInput !== undefined) {
      const revalidated = validateInput(tool.inputSchema, hookResult.modifiedInput);
      if (revalidated.ok) {
        input = revalidated.value;
        // N3: the rewritten input goes through the SAME hard boundaries
        readOutsideWorkspace = this.readsOutsideWorkspace(toolName, input, baseCtx.cwd);
        const rechecked = this.boundaryViolation(toolName, input, baseCtx.cwd);
        if (rechecked) {
          await this.deps.hooks.emit('PostToolUseFailure', {
            tool: toolName,
            reason: rechecked.reason,
          });
          return this.finish(outcome, rechecked.message, true, true);
        }
      }
    }

    let permissionAction: 'allow' | 'deny' | 'ask' | null = null;
    let permissionReason = '';

    if (hookResult?.decision === 'deny') {
      await this.deps.hooks.emit('PostToolUseFailure', {
        tool: toolName,
        reason: hookResult.reason ?? 'denied by hook',
      });
      return this.finish(
        outcome,
        `Denied by PreToolUse hook: ${hookResult.reason ?? 'no reason given'}. Adjust your approach.`,
        true,
        true,
      );
    }
    if (hookResult?.decision === 'allow' && !hookResult.anyFailed) {
      permissionAction = 'allow';
    } else if (hookResult?.decision === 'ask') {
      permissionAction = 'ask';
      permissionReason = hookResult.reason ?? 'hook requested approval';
    } else if (hookResult?.anyFailed) {
      // guard crashed → fail closed
      permissionAction = 'ask';
      permissionReason = hookResult.reason ?? 'a PreToolUse hook failed; manual approval required';
    }

    // 2. permission chain (still runs for allow-by-hook? no — hook allow wins)
    if (!permissionAction) {
      const decision = this.deps.permissions.check({
        tool: toolName,
        input,
        subject: tool.subject(input),
        subjects: tool.subjects?.(input),
        cwd: baseCtx.cwd,
      });
      permissionAction = decision.action;
      permissionReason = decision.action === 'allow' ? (decision.reason ?? '') : decision.reason;
    }

    // 2b. reads outside the workspace are NEVER silent: an allow (mode, rule,
    const guard = this.deps.permissions.check({ tool: toolName, input, subject: tool.subject(input), subjects: tool.subjects?.(input), cwd: baseCtx.cwd });
    if (guard.action === 'deny' || (guard.action === 'ask' && guard.reason.startsWith('Dangerous command'))) {
      permissionAction = guard.action; permissionReason = guard.reason;
    }
    //     or hook) is downgraded to an approval so the user sees the target.
    //     dontAsk's deny stands (unattended stays closed).
    if (readOutsideWorkspace && permissionAction === 'allow') {
      permissionAction = 'ask';
      permissionReason = 'this read targets a path OUTSIDE the workspace';
    }

    const batch = baseCtx.approvalBatch;
    const sameCategory = batch?.operations.filter(op => toolClass(op.tool) === toolClass(toolName) && toolClass(op.tool) !== 'other');
    const approvedInput = batch && this.batches.get(batch.id)?.get(toolCallId);
    const batchEligible = !readOutsideWorkspace && !hookResult?.anyFailed && hookResult?.decision !== 'ask' && !/danger|outside|destructive/i.test(permissionReason);
    if (permissionAction === 'ask' && batchEligible && approvedInput === JSON.stringify({ tool: toolName, input })) permissionAction = 'allow';

    // 3. ask → PermissionRequest hook may auto-resolve, else ask the human
    if (permissionAction === 'ask') {
      const autoResolved = await this.deps.hooks.emit('PermissionRequest', {
        tool: toolName,
        input,
        subject: tool.subject(input),
        reason: permissionReason,
      });
      if (autoResolved?.decision === 'allow' && !autoResolved.anyFailed) {
        permissionAction = 'allow';
      } else if (autoResolved?.decision === 'deny') {
        await this.deps.hooks.emit('PermissionDenied', { tool: toolName, reason: autoResolved.reason });
        return this.finish(
          outcome,
          `Permission denied by hook: ${autoResolved.reason ?? 'no reason given'}`,
          true,
          true,
        );
      } else {
        const req: ApprovalRequest = {
          itemId: newId('appr'),
          threadId: baseCtx.threadId,
          tool: toolName,
          title: tool.summarize(input),
          detail: permissionReason || undefined,
          input,
          riskLevel: /danger|outside|destructive/i.test(permissionReason) ? 'high' : 'normal',
          suggestedRule: ruleStringFor(toolName, input, tool),
          category: toolClass(toolName),
          categoryLabel: { edit: '文件编辑', shell: '命令执行', read: '文件读取', other: '此工具' }[toolClass(toolName)],
          batch: batchEligible && sameCategory && sameCategory.length > 1 ? sameCategory : undefined,
        };
        this.deps.onState?.(baseCtx.threadId, 'WAITING_FOR_PERMISSION');
        let userDecision: ApprovalDecision;
        try {
          userDecision = await this.waitForApproval(req, tool, input, baseCtx, !readOutsideWorkspace && !hookResult?.anyFailed && hookResult?.decision !== 'ask' && req.riskLevel !== 'high');
        } finally {
          this.deps.onState?.(baseCtx.threadId, 'PERMISSION_RESOLVED');
        }
        if (userDecision.decision === 'deny') {
          await this.deps.hooks.emit('PermissionDenied', { tool: toolName, reason: userDecision.reason });
          return this.finish(
            outcome,
            `The user denied this ${toolName} call${userDecision.reason ? `: ${userDecision.reason}` : ''}. Ask what they'd prefer, or find another approach.`,
            true,
            true,
          );
        }
        if (userDecision.scope === 'batch' && batch && req.batch && batchEligible) {
          this.batches.set(batch.id, new Map(req.batch.map(op => [op.id, JSON.stringify({ tool: op.tool, input: op.input })])));
        } else if (userDecision.scope === 'category' && req.riskLevel !== 'high' && !readOutsideWorkspace) {
          this.deps.permissions.allowCategory(toolName);
          this.deps.onRememberCategory?.(toolName);
        } else if (userDecision.remember === 'session') {
          this.deps.permissions.addSessionRule(ruleStringFor(toolName, input, tool));
        } else if (userDecision.remember === 'always') {
          this.deps.onRememberAlways?.(ruleStringFor(toolName, input, tool));
        }
      }
    } else if (permissionAction === 'deny') {
      await this.deps.hooks.emit('PermissionDenied', { tool: toolName, reason: permissionReason });
      return this.finish(outcome, `Permission denied: ${permissionReason}`, true, true);
    }

    // 4. execute with streaming
    const runCtx: ToolRunContext = {
      ...baseCtx,
      emitItem: async (item) => {
        outcome.emittedItems.push(item);
      },
      askUser: async (question, options) => {
        this.deps.onState?.(baseCtx.threadId, 'WAITING_FOR_USER');
        try { return await abortable(this.deps.askUser({
          itemId: newId('ui'),
          threadId: baseCtx.threadId,
          question,
          options,
        }), baseCtx.signal); } finally {
          this.deps.onState?.(baseCtx.threadId, 'USER_INPUT_RESOLVED');
        }
      },
      log: this.deps.log,
    };

    const execute = async () => {
      try {
        if (baseCtx.signal.aborted) return this.finish(outcome, '操作已停止', true);
        const checkpoints = this.deps.checkpoints;
        const tracked = checkpoints && (toolName === 'write' || toolName === 'apply_patch')
          ? await checkpoints.capture(baseCtx.threadId, baseCtx.turnId, baseCtx.cwd, tool.summarize(input), tool.subjects?.(input) ?? [tool.subject(input)], toolCallId) : undefined;
        let finalText = '';
        let isError = false;
        try {
          if (baseCtx.signal.aborted || this.deps.permissions.check({ tool: toolName, input, subject: tool.subject(input), subjects: tool.subjects?.(input), cwd: baseCtx.cwd }).action === 'deny') throw new Error('操作已停止或权限已撤销');
          for await (const ev of tool.run(input, runCtx) as AsyncIterable<ToolEvent>) {
            if (ev.type === 'output') {
              outcome.deltas.push(ev.text);
              this.deps.onOutput?.(baseCtx.threadId, toolCallId, ev.text);
            } else {
              finalText = ev.text;
              isError = Boolean(ev.isError);
            }
          }
        } finally {
          if (tracked) await checkpoints!.complete(tracked);
        }
        await this.deps.hooks.emit(isError ? 'PostToolUseFailure' : 'PostToolUse', { tool: toolName, input, output: finalText });
        return this.finish(outcome, finalText || '(no output)', isError);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.deps.hooks.emit('PostToolUseFailure', { tool: toolName, reason: msg });
        return this.finish(outcome, 'Error running ' + toolName + ': ' + msg, true);
      }
    };
    return this.deps.checkpoints && (toolName === 'write' || toolName === 'apply_patch')
      ? this.deps.checkpoints.exclusive(baseCtx.cwd, execute) : execute();
  }

  private finish(
    outcome: ToolRunOutcome,
    output: string,
    isError: boolean,
    denied = false,
  ): ToolRunOutcome {
    return { ...outcome, output, isError, denied };
  }

  private async waitForApproval(req: ApprovalRequest, tool: ToolDefinition, input: unknown, ctx: Omit<ToolRunContext, 'emitItem' | 'askUser'>, canAutoAllow: boolean): Promise<ApprovalDecision> {
    let unsubscribe = () => {};
    const policyChanged = new Promise<ApprovalDecision>(resolve => {
      unsubscribe = this.deps.permissions.subscribe(() => {
        const next = this.deps.permissions.check({ tool: req.tool, input, subject: tool.subject(input), subjects: tool.subjects?.(input), cwd: ctx.cwd });
        if (next.action === 'deny') resolve({ decision: 'deny', reason: next.reason });
        else if (next.action === 'allow' && canAutoAllow) resolve({ decision: 'allow' });
      });
    });
    try { return await abortable(Promise.race([this.deps.requestApproval(req), policyChanged]), ctx.signal); }
    finally { unsubscribe(); this.deps.cancelApproval?.(req.itemId); }
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Interrupted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Interrupted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function ruleStringFor(toolName: string, input: unknown, tool: ToolDefinition): string {
  const subject = tool.subject(input);
  if (toolName === 'shell') return `shell:${subject.split(/\s+/).slice(0, 3).join(' ')}`;
  if (['write', 'read', 'apply_patch'].includes(toolName) && subject) {
    return `${toolName === 'apply_patch' ? 'edit' : toolName}:${subject}`;
  }
  return toolName;
}
