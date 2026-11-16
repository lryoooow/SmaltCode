/**
 * Kernel-native Subagent Delegation (`delegate_task` — U5).
 *
 * Allows the primary agent to spawn an isolated child turn with its own fresh
 * context window so large codebase exploration, independent verification, or
 * focused subtasks return a concise, high-signal report without polluting the
 * parent conversation's prefix cache or context window.
 *
 * Security & Resource Guarantees:
 * - Zero recursion: child agents never have access to `delegate_task` or `ask_user`.
 * - Strict RunPolicy budget: capped requests, tokens, tool calls, and wall-clock deadline.
 * - Permission inheritance: `explorer` is strictly read-only (`read`, `glob`, `grep`);
 *   `verifier` and `worker` inherit the parent thread's PermissionService so
 *   `plan` / `dontAsk` / `deny` rules can NEVER be bypassed via delegation.
 * - Emits `SubagentStart` and `SubagentStop` hooks on the parent HookBus.
 */

import { SessionRunStateMachine } from '../../core/state-machine.js';
import { TurnRunner } from '../../core/turn-runner.js';
import { ContextPipeline, envInterceptor, repoInstructionsInterceptor, systemInterceptor } from '../../context/pipeline.js';
import { Compactor } from '../../compact/compactor.js';
import { ToolOrchestrator } from '../orchestrator.js';
import { ToolRegistry } from '../registry.js';
import type { ModelStreamer, ReasoningEffort } from '../../models/types.js';
import type { ModelRef, Settings } from '../../config/settings.js';
import type { PermissionService } from '../../permissions/service.js';
import type { HookBus } from '../../hooks/bus.js';
import type { CheckpointStore } from '../../storage/checkpoints.js';
import type { ThreadStore, StoreEvent } from '../../storage/thread-store.js';
import type { ApprovalDecision, ApprovalRequest, Item } from '../../protocol/types.js';
import type { RunPolicy } from '../../core/run-policy.js';
import type { ToolDefinition, ToolEvent } from '../types.js';
import { budgetToolOutput, newId } from '../../util.js';

export type SubagentRole = 'explorer' | 'verifier' | 'worker';

const EXPLORER_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch'];
const VERIFIER_TOOLS = ['read', 'glob', 'grep', 'shell'];
const WORKER_EXCLUDED = new Set([
  'delegate_task',
  'ask_user',
  'plan',
  'task_checkpoint',
  'process_read',
  'process_stop',
  'process_write',
  'resource_list',
  'resource_search',
  'resource_read',
  'resource_write',
  'ssh_connections',
  'ssh_read',
  'ssh_write',
  'ssh_exec',
  'ssh_process_read',
  'ssh_process_stop',
  'container_read',
  'container_write',
  'container_exec',
  'container_process_read',
  'container_process_stop',
]);

class EphemeralSubagentStore implements ThreadStore {
  private readonly events = new Map<string, StoreEvent[]>();
  append(threadId: string, event: StoreEvent): void {
    const list = this.events.get(threadId) ?? [];
    list.push(event);
    this.events.set(threadId, list);
  }
  load(threadId: string): StoreEvent[] | null {
    return this.events.get(threadId) ?? null;
  }
  listMetas() { return []; }
  exists(threadId: string): boolean { return this.events.has(threadId); }
  archive(): boolean { return false; }
}

const ROLE_INSTRUCTIONS: Record<SubagentRole, string> = {
  explorer:
    'You are a focused read-only Explorer subagent. Search and read relevant files efficiently (batching parallel reads/greps when possible), then return a concise, well-structured report with exact file paths, line references, and key findings. Do NOT speculate about unread files.',
  verifier:
    'You are an independent Verifier subagent. Inspect recent code changes, run relevant typecheck/lint/test checks if permitted, and report pass/fail evidence plus any concrete regressions or edge cases.',
  worker:
    'You are a focused Worker subagent executing a bounded subtask inside the workspace. Read target files first, make minimal surgical edits, verify if permitted, and summarize exact files changed and verification status.',
};

export interface SubagentToolDeps {
  gatewayFor(threadId: string): { gateway: ModelStreamer; modelRef: ModelRef; settings: Settings; reasoningEffort?: ReasoningEffort };
  permissionsFor(threadId: string): PermissionService;
  tools: ToolRegistry;
  checkpoints: CheckpointStore;
  hooks: HookBus;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  cancelApproval?(id: string): void;
  onRememberAlways?(rule: string): void;
  onUsage?(threadId: string, inputTokens: number, outputTokens: number): void;
  log(msg: string): void;
}

export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition {
  return {
    name: 'delegate_task',
    description:
      'Delegate a focused subtask to an isolated subagent with its own clean context window. Use role="explorer" (read-only, parallel-safe) to research unfamiliar parts of a large codebase without bloating the main conversation; role="verifier" to independently review/test changes; or role="worker" for a self-contained implementation subtask.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['explorer', 'verifier', 'worker'],
          description: 'Subagent specialization: explorer (read-only research), verifier (check/test), or worker (bounded edit)',
        },
        description: {
          type: 'string',
          description: 'Short 3-8 word label for what this subagent is investigating or doing',
          minLength: 2,
          maxLength: 120,
        },
        prompt: {
          type: 'string',
          description: 'Complete, self-contained task brief (subagents do not see the parent conversation history)',
          minLength: 4,
          maxLength: 24000,
        },
      },
      required: ['role', 'description', 'prompt'],
    },
    available: ({ threadId }) => !threadId.startsWith('sub_'),
    subject: (input) => {
      const rec = input as { role?: string; description?: string } | undefined;
      return `${rec?.role ?? 'explorer'}: ${rec?.description ?? 'subtask'}`;
    },
    summarize: (input) => {
      const rec = input as { role?: string; description?: string } | undefined;
      return `delegate (${rec?.role ?? 'explorer'}) ${rec?.description ?? ''}`.trim();
    },
    async *run(input, ctx): AsyncIterable<ToolEvent> {
      const { role, description, prompt } = input as {
        role: SubagentRole;
        description: string;
        prompt: string;
      };

      // Prevent recursive subagent spawning or unattended escalation
      if (ctx.threadId.startsWith('sub_') || ctx.policy?.noBackground) {
        yield {
          type: 'result',
          text: 'Error: subagent delegation is disabled inside nested subagents or unattended background runs.',
          isError: true,
        };
        return;
      }

      const parentPerms = deps.permissionsFor(ctx.threadId);
      if (role === 'worker' && parentPerms.mode === 'plan') {
        yield {
          type: 'result',
          text: 'Error: cannot spawn a mutating worker subagent while the thread is in plan (read-only) mode. Use role="explorer" instead.',
          isError: true,
        };
        return;
      }

      const subId = newId('sub');
      const startHook = await deps.hooks.emit('SubagentStart', {
        threadId: ctx.threadId,
        subagentId: subId,
        role,
        description,
        cwd: ctx.cwd,
      });
      if (startHook?.decision === 'deny' || startHook?.anyFailed) {
        yield {
          type: 'result',
          text: `Subagent blocked by hook: ${startHook?.reason ?? 'hook execution failed'}`,
          isError: true,
        };
        return;
      }

      yield { type: 'output', text: `[${role}] Starting subtask: ${description}\n` };

      const { gateway, modelRef, settings, reasoningEffort } = deps.gatewayFor(ctx.threadId);
      const childTools = new ToolRegistry([]);
      for (const spec of deps.tools.specs({ cwd: ctx.cwd, threadId: ctx.threadId })) {
        if (WORKER_EXCLUDED.has(spec.name)) continue;
        if (role === 'explorer' && !EXPLORER_TOOLS.includes(spec.name)) continue;
        if (role === 'verifier' && !VERIFIER_TOOLS.includes(spec.name)) continue;
        const def = deps.tools.get(spec.name);
        if (def) childTools.register(def);
      }
      childTools.cloneGuardsFrom(deps.tools);
      const allowedToolNames = childTools.specs({ cwd: ctx.cwd, threadId: ctx.threadId }).map((s) => s.name);
      if (!allowedToolNames.length) {
        yield {
          type: 'result',
          text: 'Error: no local subagent tools are available in this execution scope (e.g., remote SSH/container target). Use direct target tools instead.',
          isError: true,
        };
        return;
      }

      const parentScopedCheckpoints: CheckpointStore = Object.assign(
        Object.create(Object.getPrototypeOf(deps.checkpoints)),
        deps.checkpoints,
        {
          capture: (_th: string, _turn: string, cwd: string, title: string, paths: string[], operationId?: string) =>
            deps.checkpoints.capture(ctx.threadId, ctx.turnId, cwd, `[${role}] ${title}`, paths, operationId),
        },
      );

      const childStore = new EphemeralSubagentStore();
      const childHooks = deps.hooks.fork({}, { cwd: ctx.cwd, threadId: subId, parentThreadId: ctx.threadId });
      const childOrchestrator = new ToolOrchestrator({
        checkpoints: parentScopedCheckpoints,
        tools: childTools,
        permissions: parentPerms,
        hooks: childHooks,
        // Route approval requests under parent threadId so the Desktop UI displays them on the active conversation!
        requestApproval: (req) => deps.requestApproval({ ...req, threadId: ctx.threadId, title: `[子智能体 · ${description}] ${req.title}` }),
        cancelApproval: (id) => deps.cancelApproval?.(id),
        onRememberAlways: deps.onRememberAlways,
        askUser: async () => 'Subagents cannot ask interactive questions; report any ambiguity in your final summary.',
        onOutput: (_th, _item, delta) => { void delta; },
        log: deps.log,
      });

      const contextWindow = gateway.prepare ? await gateway.prepare(modelRef, ctx.signal).catch(() => 128_000) : 128_000;
      if (ctx.signal.aborted) {
        yield { type: 'result', text: 'Interrupted', isError: true };
        return;
      }
      const compactor = new Compactor(gateway, childHooks, {
        ...settings.compact,
        contextWindow,
      });
      const pipeline = new ContextPipeline([
        envInterceptor(),
        repoInstructionsInterceptor(),
        {
          name: 'subagent-role',
          priority: 1520,
          async intercept(tctx) {
            tctx.prompt.unshift({ role: 'system', content: ROLE_INSTRUCTIONS[role] });
          },
        },
        systemInterceptor(),
      ]);

      const childRunner = new TurnRunner({
        gateway,
        tools: childTools,
        orchestrator: childOrchestrator,
        hooks: childHooks,
        compactor,
        pipeline,
        store: childStore,
        notify: () => {},
        log: deps.log,
      });

      const childAbort = new AbortController();
      const onParentAbort = () => childAbort.abort();
      ctx.signal.addEventListener('abort', onParentAbort, { once: true });
      if (ctx.signal.aborted) childAbort.abort();

      const runPolicy: RunPolicy = {
        maxRequests: role === 'explorer' ? 10 : 14,
        maxTokens: 180_000,
        maxTools: role === 'explorer' ? 24 : 30,
        deadlineAt: Date.now() + 180_000,
        signal: childAbort.signal,
        unattended: false,
        toolPolicy: {
          allowedTools: allowedToolNames,
          workspaceOnly: true,
          noBackground: true,
        },
      };

      const sm = new SessionRunStateMachine();
      const history: import('../../models/types.js').ChatMessage[] = [];
      const items: Item[] = [];
      let totalIn = 0;
      let totalOut = 0;

      try {
        const outcome = await childRunner.runTurn(
          sm,
          {
            policy: runPolicy,
            threadId: subId,
            cwd: ctx.cwd,
            modelRef,
            reasoningEffort: () => reasoningEffort,
            history,
            items,
            steerQueue: [],
            signal: childAbort.signal,
            onHistoryReplaced: (next) => {
              history.length = 0;
              history.push(...next);
            },
            addUsage: (i, o) => {
              totalIn += i;
              totalOut += o;
              deps.onUsage?.(ctx.threadId, i, o);
            },
            usageTotals: () => ({ inputTokens: totalIn, outputTokens: totalOut }),
            contextWindow: () => contextWindow,
          },
          prompt,
        );

        await deps.hooks.emit('SubagentStop', {
          threadId: ctx.threadId,
          subagentId: subId,
          role,
          failed: outcome.failed,
          interrupted: outcome.interrupted,
          toolCount: outcome.summary?.toolCount ?? 0,
        });

        const touchedFiles = items
          .filter((i): i is Extract<Item, { kind: 'fileChange' }> => i.kind === 'fileChange' && i.status === 'completed')
          .map((f) => `${f.changeKind}: ${f.path}`);

        const header = `[Subagent ${role} · "${description}" | tools: ${outcome.summary?.toolCount ?? 0} | tokens: ${totalIn + totalOut}${outcome.stopReason ? ` | limit: ${outcome.stopReason}` : ''}]`;
        const filesBlock = touchedFiles.length ? `\nFiles changed:\n${touchedFiles.map((f) => `- ${f}`).join('\n')}\n` : '';
        const body = outcome.assistantText.trim() || outcome.error || '(subagent completed without a text report)';

        yield {
          type: 'result',
          text: budgetToolOutput(`${header}${filesBlock}\n${body}`, 12_000),
          isError: outcome.failed,
        };
      } finally {
        ctx.signal.removeEventListener('abort', onParentAbort);
      }
    },
  };
}
