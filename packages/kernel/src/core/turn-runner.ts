/**
 * TurnRunner — the agent main loop:
 *
 *   assemble context → sample → (tool calls → results → re-sample)*
 *   → stop hooks → done
 *
 * Steering messages that arrive mid-turn are queued and folded into the next
 * sampling step. Interruption is first-class: an aborted request or tool is
 * reported as `interrupted`, never as a normal completion.
 */

import type { ContextPipeline, TurnContext } from '../context/pipeline.js';
import type { Compactor } from '../compact/compactor.js';
import type { HookBus } from '../hooks/bus.js';
import type { ModelStreamer } from '../models/types.js';
import type { ChatMessage, ToolCall } from '../models/types.js';
import { estimateHistoryTokens } from '../models/types.js';
import { ModelError, type ModelDelta, type ModelRequest } from '../models/types.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelRef } from '../config/settings.js';
import {
  Notifications,
  type AgentMessageItem,
  type CommandExecutionItem,
  type FileChangeItem,
  type Item,
  type PlanItem,
  type ThreadTokenUsage,
} from '../protocol/types.js';

import type { ThreadStore } from '../storage/thread-store.js';
import type { ToolOrchestrator, ToolRunOutcome } from '../tools/orchestrator.js';
import type { ToolRegistry } from '../tools/registry.js';
import { errorMessage, newId, nowIso } from '../util.js';
import type { SessionRunStateMachine } from './state-machine.js';

export interface TurnRunnerDeps {
  gateway: ModelStreamer;
  tools: ToolRegistry;
  orchestrator: ToolOrchestrator;
  hooks: HookBus;
  compactor: Compactor;
  pipeline: ContextPipeline;
  store: ThreadStore;
  notify(method: string, params?: unknown): void;
  log(msg: string): void;
}

export interface TurnOutcome {
  turnId: string;
  interrupted: boolean;
  failed: boolean;
  error?: string;
  assistantText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  async compact(state: SessionRunStateMachine, runtime: { threadId: string; modelRef: ModelRef; history: ChatMessage[]; signal: AbortSignal; onHistoryReplaced(history: ChatMessage[]): void }): Promise<{ compacted: boolean; reason?: string }> {
    if (state.isRunning()) throw new Error('Stop the task before compacting');
    state.transition('COMPACT_STARTED');
    try {
      const result = await this.deps.compactor.compact(runtime.history, runtime.modelRef, runtime.signal);
      if (result.compacted) {
        runtime.onHistoryReplaced(result.history);
        this.deps.store.append(runtime.threadId, { t: 'compacted', summary: result.summary ?? '', history: result.history, at: nowIso() });
        this.deps.notify(Notifications.threadCompacted, { threadId: runtime.threadId });
      }
      return { compacted: result.compacted, reason: result.reason };
    } finally { state.transition('FORCE_IDLE'); }
  }

  async runTurn(
    state: SessionRunStateMachine,
    runtime: {
      threadId: string;
      cwd: string;
      modelRef: ModelRef;
      history: ChatMessage[];
      items: Item[];
      steerQueue: import('../protocol/types.js').UserPrompt[];
      signal: AbortSignal;
      onHistoryReplaced(history: ChatMessage[]): void;
      addUsage(input: number, output: number): void;
      usageTotals(): { inputTokens: number; outputTokens: number };
      contextWindow(): number;
    },
    prompt: import('../protocol/types.js').UserPrompt,
  ): Promise<TurnOutcome> {
    const { text: input, displayText, references } = typeof prompt === 'string' ? { text: prompt, displayText: undefined, references: undefined } : prompt;
    const { threadId } = runtime;
    const startedAt = Date.now();
    const firstItem = runtime.items.length;
    let toolCount = 0;
    let reportedTokens = 0;
    const turnId = newId('turn');
    const outcome: TurnOutcome = {
      turnId,
      interrupted: false,
      failed: false,
      assistantText: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    state.transition('RUN_PREPARING');
    this.deps.store.append(threadId, { t: 'turn-started', turnId, at: nowIso() });
    this.deps.notify(Notifications.turnStarted, { threadId, turnId });

    // user message → item + history + store
    const userItem: Item = {
      kind: 'userMessage',
      id: newId('um'),
      threadId,
      turnId,
      createdAt: nowIso(),
      status: 'completed',
      text: displayText ?? input,
      references,
    };
    runtime.items.push(userItem);
    runtime.history.push({ role: 'user', content: input });
    this.deps.store.append(threadId, { t: 'user-msg', id: userItem.id, text: input, displayText, references, at: nowIso() });
    this.deps.notify(Notifications.itemStarted, { item: userItem });
    this.deps.notify(Notifications.itemCompleted, { item: userItem });

    await this.deps.hooks.emit('UserPromptSubmit', { threadId, turnId, prompt: input });
    state.transition('RUN_ACCEPTED');

    let stopHookActive = false;
    // Continuous by default. Hosts can opt into a limit for unattended runs;
    // desktop tasks finish naturally or through the existing interrupt path.
    const requestedSteps = Number(process.env.SMALT_MAX_STEPS);
    const maxSteps = Number.isFinite(requestedSteps) && requestedSteps > 0 ? Math.floor(requestedSteps) : Infinity;
    let step = 0;

    try {
      for (; step < maxSteps; step++) {
        if (runtime.signal.aborted) {
          outcome.interrupted = true;
          break;
        }

        // fold steering messages into the history before the next sample
        while (runtime.steerQueue.length) {
          const queued = runtime.steerQueue.shift()!;
          const { text: msg, displayText, references } = typeof queued === 'string' ? { text: queued, displayText: undefined, references: undefined } : queued;
          runtime.history.push({ role: 'user', content: msg });
          const steerItem: Item = {
            kind: 'userMessage',
            id: newId('um'),
            threadId,
            turnId,
            createdAt: nowIso(),
            status: 'completed',
            text: displayText ?? msg,
            references,
          };
          runtime.items.push(steerItem);
          this.deps.store.append(threadId, { t: 'user-msg', id: steerItem.id, text: msg, displayText, references, at: nowIso() });
          this.deps.notify(Notifications.itemStarted, { item: steerItem });
          this.deps.notify(Notifications.itemCompleted, { item: steerItem });
        }

        // mid-turn compaction (estimated tokens are the floor, reported the ceiling)
        const reported = reportedTokens;
        if (this.deps.compactor.needsCompaction(runtime.history, reported, runtime.contextWindow())) {
          state.transition('COMPACT_STARTED');
          const result = await this.deps.compactor.compact(runtime.history, runtime.modelRef, runtime.signal);
          if (result.compacted) {
            runtime.onHistoryReplaced(result.history);
            runtime.history = result.history;
            this.deps.store.append(threadId, { t: 'compacted', summary: result.summary ?? '', history: result.history, at: nowIso() });
            this.deps.notify(Notifications.threadCompacted, { threadId, summary: result.summary });
          }
          state.transition('COMPACT_ENDED');
          if (runtime.signal.aborted) {
            outcome.interrupted = true;
            break;
          }
        }

        // assemble context
        const ctx: TurnContext = {
          threadId,
          turnId,
          cwd: runtime.cwd,
          modelRef: runtime.modelRef,
          history: runtime.history,
          prompt: [...runtime.history],
          input,
          toolNames: this.deps.tools.list().map((t) => t.name),
          systemExtras: [],
        };
        const messages = await this.deps.pipeline.assemble(ctx);

        // sample
        state.transition('MODEL_REQUEST_STARTED');
        let text = '';
        let reasoningText = '';
        const toolCalls: ToolCall[] = [];
        const partialArgs = new Map<string, string>();
        let sawFirstDelta = false;
        let finish: 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other' = 'other';
        const aid = newId('am');
        const rid = newId('rs');
        let agentStarted = false;
        let reasoningStarted = false;
        let streamError: unknown;

        try {
          for await (const delta of this.streamWithRetry(runtime.modelRef, {
            messages,
            tools: this.deps.tools.specs(),
            signal: runtime.signal,
          }, () => state.transition('RETRYING'), () => state.transition('MODEL_REQUEST_STARTED'))) {
            if (!sawFirstDelta) {
              sawFirstDelta = true;
              state.transition('MODEL_STREAM_STARTED');
            }
            switch (delta.type) {
              case 'reasoning': {
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  this.deps.notify(Notifications.itemStarted, { item: { kind: 'reasoning', id: rid, threadId, turnId, createdAt: nowIso(), status: 'inProgress', text: '' } });
                }
                reasoningText += delta.text;
                this.deps.notify(Notifications.reasoningDelta, { threadId, turnId, itemId: rid, delta: delta.text });
                break;
              }
              case 'text': {
                if (!agentStarted) {
                  agentStarted = true;
                  this.deps.notify(Notifications.itemStarted, { item: { kind: 'agentMessage', id: aid, threadId, turnId, createdAt: nowIso(), status: 'inProgress', text: '' } });
                }
                text += delta.text;
                this.deps.notify(Notifications.agentMessageDelta, { threadId, turnId, itemId: aid, delta: delta.text });
                break;
              }
              case 'toolCallStart': {
                toolCalls.push({ id: delta.id, name: delta.name, arguments: '' });
                partialArgs.set(delta.id, '');
                break;
              }
              case 'toolCallDelta': {
                partialArgs.set(delta.id, (partialArgs.get(delta.id) ?? '') + delta.argsDelta);
                break;
              }
              case 'usage': {
                reportedTokens = delta.inputTokens;
                outcome.usage.inputTokens += delta.inputTokens;
                outcome.usage.outputTokens += delta.outputTokens;
                runtime.addUsage(delta.inputTokens, delta.outputTokens);
                break;
              }
              case 'done': {
                finish = delta.finishReason;
                break;
              }
            }
          }
        } catch (err) {
          if (isAbort(err) || runtime.signal.aborted) {
            outcome.interrupted = true;
          } else streamError = err;
        }

        for (const tc of toolCalls) {
          tc.arguments = partialArgs.get(tc.id) ?? '';
        }
        state.transition('MODEL_RESPONSE_DONE');

        // persist assistant output
        if (reasoningText.trim()) {
          const item: Item = { kind: 'reasoning', id: rid, threadId, turnId, createdAt: nowIso(), status: outcome.interrupted || streamError ? 'failed' : 'completed', text: reasoningText };
          runtime.items.push(item);
          this.deps.store.append(threadId, { t: 'reasoning', id: rid, text: reasoningText, status: item.status, at: nowIso() });
          this.deps.notify(Notifications.itemCompleted, { item });
        }
        if (text.trim()) {
          const item: AgentMessageItem = { kind: 'agentMessage', id: aid, threadId, turnId, createdAt: nowIso(), status: outcome.interrupted || streamError ? 'failed' : 'completed', text };
          runtime.items.push(item);
          this.deps.store.append(threadId, { t: 'agent-msg', id: aid, text, status: item.status, at: nowIso() });
          this.deps.notify(Notifications.itemCompleted, { item });
          outcome.assistantText += (outcome.assistantText ? '\n\n' : '') + text;
        }

        if (runtime.signal.aborted) {
          if (text.trim()) runtime.history.push({ role: 'assistant', content: text, reasoningContent: reasoningText || undefined });
          outcome.interrupted = true;
          break;
        }
        if (streamError) {
          if (text.trim()) runtime.history.push({ role: 'assistant', content: text, reasoningContent: reasoningText || undefined });
          throw streamError;
        }

        if (!toolCalls.length) {
          if (text.trim()) runtime.history.push({ role: 'assistant', content: text, reasoningContent: reasoningText || undefined });
          // model chose to stop → consult stop hooks
          const stopDecision = await this.deps.hooks.emit('Stop', { threadId, turnId });
          if (stopDecision?.decision === 'deny' && !stopDecision.anyFailed) {
            if (!stopHookActive) {
              stopHookActive = true;
              const reason = stopDecision.reason ?? 'a Stop hook blocked ending this turn';
              runtime.history.push({ role: 'user', content: `<system-reminder>Stop blocked: ${reason}. Continue working toward completion.</system-reminder>` });
              continue;
            }
            // one block per turn only — avoid infinite loop
          }
          if (runtime.steerQueue.length) continue;
          break;
        }

        // execute tools in order
        runtime.history.push({
          role: 'assistant',
          content: text || null,
          toolCalls: toolCalls.map((tc) => ({ ...tc })),
          reasoningContent: reasoningText || undefined,
        });
        for (const tc of toolCalls) {
          this.deps.store.append(threadId, { t: 'tool-call', id: tc.id, tool: tc.name, input: safeJsonParse(tc.arguments), at: nowIso() });
        }

        const approvalBatch = { id: newId('batch'), operations: toolCalls.map(tc => {
          const input = safeJsonParse(tc.arguments);
          let title = tc.name; try { title = this.deps.tools.get(tc.name)?.summarize(input) ?? title; } catch { /* invalid calls are rejected individually */ }
          return { id: tc.id, tool: tc.name, input, title };
        }) };
        try { for (const tc of toolCalls) {
          if (runtime.signal.aborted) {
            outcome.interrupted = true;
            break;
          }
          state.transition('TOOL_STARTED');
          toolCount++;
          const parsed = safeJsonParse(tc.arguments) as Record<string, unknown>;
          this.deps.notify(Notifications.itemStarted, { item: {
            kind: 'commandExecution', id: tc.id, threadId, turnId, createdAt: nowIso(), status: 'inProgress',
            tool: tc.name, command: typeof parsed.command === 'string' ? parsed.command : `${tc.name} ${String(parsed.path ?? '')}`, output: '', exitCode: null,
          } });
          const result = await this.executeToolCall(tc, { threadId, turnId, cwd: runtime.cwd, signal: runtime.signal, approvalBatch: { ...approvalBatch, operations: approvalBatch.operations.slice(toolCalls.indexOf(tc)) } });
          this.recordToolResult(runtime, outcome, tc, result);
          state.transition('TOOL_ENDED');
        } } finally { this.deps.orchestrator.endBatch(approvalBatch.id); }
        if (outcome.interrupted) {
          for (const tc of toolCalls) {
            if (runtime.history.some(m => m.role === 'tool' && m.toolCallId === tc.id)) continue;
            this.recordToolResult(runtime, outcome, tc, { toolCallId: tc.id, toolName: tc.name, output: 'Cancelled before execution', isError: true, denied: false, deltas: [], emittedItems: [] });
          }
          break;
        }

        if (finish === 'length') {
          // context exhausted mid-answer — try compaction once, then continue
          const forceCompact = await this.deps.compactor.compact(runtime.history, runtime.modelRef, runtime.signal);
          if (forceCompact.compacted) {
            runtime.onHistoryReplaced(forceCompact.history);
            runtime.history = forceCompact.history;
            this.deps.store.append(threadId, { t: 'compacted', summary: forceCompact.summary ?? '', history: forceCompact.history, at: nowIso() });
            this.deps.notify(Notifications.threadCompacted, { threadId, summary: forceCompact.summary });
          }
        }
        // loop continues → MODEL_REQUEST_STARTED
      }
      if (step >= maxSteps && !outcome.interrupted) throw new Error(`已达到 ${maxSteps} 步执行上限，请检查当前结果后继续。`);
    } catch (err) {
      outcome.failed = true;
      outcome.error = errorMessage(err);
      if (isAbort(err) || runtime.signal.aborted) {
        outcome.interrupted = true;
        outcome.failed = false;
        outcome.error = undefined;
      }
      this.deps.log(`turn ${turnId} error: ${outcome.error ?? 'aborted'}`);
    }

    // finalize
    if (outcome.usage.inputTokens || outcome.usage.outputTokens) {
      this.deps.store.append(threadId, {
        t: 'usage',
        inputTokens: runtime.usageTotals().inputTokens,
        outputTokens: runtime.usageTotals().outputTokens,
        at: nowIso(),
      });
    }
    this.deps.store.append(threadId, { t: 'turn-ended', turnId, at: nowIso(), interrupted: outcome.interrupted || undefined });
    state.transition(outcome.failed ? 'RUN_FAILED' : 'FORCE_IDLE');
    const summary = { durationMs: Date.now() - startedAt, toolCount, fileCount: new Set(runtime.items.slice(firstItem).filter(i => i.kind === 'fileChange' && i.status === 'completed').map(i => (i as FileChangeItem).path)).size, usage: outcome.usage };

    if (outcome.failed) {
      this.deps.notify(Notifications.turnFailed, { threadId, turnId, error: outcome.error });
    } else {
      this.deps.notify(Notifications.turnCompleted, { threadId, turnId, interrupted: outcome.interrupted, summary });
    }
    this.emitUsage(runtime, reportedTokens);
    return outcome;
  }

  private async *streamWithRetry(ref: ModelRef, req: Omit<ModelRequest, 'model'>, retrying: () => void, requesting: () => void): AsyncIterable<ModelDelta> {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        for await (const delta of this.deps.gateway.stream(ref, req)) {
          if (delta.type === 'text' || delta.type === 'reasoning' || delta.type === 'toolCallStart') emitted = true;
          yield delta;
        }
        return;
      } catch (err) {
        const retryable = err instanceof ModelError ? err.status === undefined || err.status === 429 || err.status >= 500 : err instanceof TypeError;
        if (emitted || attempt >= 2 || !retryable || req.signal?.aborted) throw err;
        retrying();
        await delay(500 * 2 ** attempt, undefined, { signal: req.signal });
        requesting();
      }
    }
  }

  private async executeToolCall(
    tc: ToolCall,
    ctx: { threadId: string; turnId: string; cwd: string; signal: AbortSignal; approvalBatch?: import('../tools/types.js').ToolRunContext['approvalBatch'] },
  ): Promise<ToolRunOutcome> {
    return this.deps.orchestrator.execute(tc.id, tc.name, safeJsonParse(tc.arguments), {
      cwd: ctx.cwd,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: tc.id,
      signal: ctx.signal,
      approvalBatch: ctx.approvalBatch,
      log: this.deps.log,
    });
  }

  private recordToolResult(
    runtime: {
      threadId: string;
      items: Item[];
      history: ChatMessage[];
    },
    outcome: TurnOutcome,
    tc: ToolCall,
    result: ToolRunOutcome,
  ): void {
    const { threadId } = runtime;
    const at = nowIso();
    const base = { id: tc.id, threadId, turnId: outcome.turnId, createdAt: at };
    const emittedFiles: Item[] = result.emittedItems.filter(i => i.kind === 'fileChange').map((i, index) => ({
      ...base, id: index === 0 ? tc.id : `${tc.id}:${index}`, kind: 'fileChange', status: 'completed',
      ...(i.payload as Pick<FileChangeItem, 'path' | 'changeKind' | 'diff'>),
    }));

    // tool-defined side items (plans)
    for (const emitted of result.emittedItems) {
      if (emitted.kind === 'plan') {
        const steps = (emitted.payload as { steps: PlanItem['steps'] }).steps;
        const item: PlanItem = { ...base, kind: 'plan', status: 'completed', steps };
        runtime.items.push(item);
        this.deps.store.append(threadId, { t: 'plan', steps, at });
        this.deps.notify(Notifications.itemCompleted, { item });
      }
    }

    let item: Item;
    if (emittedFiles.length) {
      item = emittedFiles[0]!;
    } else if (tc.name === 'shell') {
      const command = String((safeJsonParse(tc.arguments) as Record<string, unknown>)?.command ?? '');
      item = {
        ...base,
        kind: 'commandExecution',
        status: result.denied ? 'blocked' : result.isError ? 'failed' : 'completed',
        command: command || result.deltas.join(''),
        tool: tc.name,
        exitCode: result.isError ? 1 : 0,
        output: result.output,
      } as CommandExecutionItem;
    } else if (tc.name === 'write' || tc.name === 'apply_patch') {
      const diffMatch = result.output.match(/^(Created|Updated) (.+)$/m);
      item = {
        ...base,
        kind: 'fileChange',
        status: result.denied ? 'blocked' : result.isError ? 'failed' : 'completed',
        path: diffMatch?.[2] ?? String((safeJsonParse(tc.arguments) as Record<string, unknown>)?.path ?? ''),
        changeKind: diffMatch?.[1] === 'Created' ? 'add' : 'update',
        diff: result.output.slice(0, 4000),
      } as FileChangeItem;
    } else {
      const parsed = safeJsonParse(tc.arguments) as Record<string, unknown>;
      const brief = Object.entries(parsed)
        .slice(0, 2)
        .map(([k, v]) => (typeof v === 'string' ? v.slice(0, 80) : k))
        .join(' ');
      item = {
        ...base,
        kind: 'commandExecution',
        status: result.denied ? 'blocked' : result.isError ? 'failed' : 'completed',
        command: `${tc.name}${brief ? ` ${brief}` : ''}`.slice(0, 300),
        tool: tc.name,
        exitCode: result.isError ? 1 : 0,
        output: result.output,
      } as CommandExecutionItem;
    }
    const items = emittedFiles.length ? emittedFiles : [item];
    if (tc.name === 'plan' && result.emittedItems.some(i => i.kind === 'plan')) items.length = 0;
    for (const completed of items) {
      runtime.items.push(completed);
      this.deps.notify(Notifications.itemCompleted, { item: completed });
    }

    runtime.history.push({
      role: 'tool',
      toolCallId: tc.id,
      content: result.output || '(no output)',
      isError: result.isError,
    });
    this.deps.store.append(threadId, {
      t: 'tool-result',
      id: tc.id,
      tool: tc.name,
      output: result.output,
      isError: result.isError,
      at,
      items,
    });
  }

  private emitUsage(runtime: { threadId: string; usageTotals(): { inputTokens: number; outputTokens: number }; contextWindow(): number; history: ChatMessage[] }, reportedTokens = 0): void {
    const totals = runtime.usageTotals();
    const est = estimateHistoryTokens(runtime.history);
    const usage: ThreadTokenUsage = {
      inputTokens: reportedTokens || est,
      outputTokens: totals.outputTokens,
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      contextWindow: runtime.contextWindow(),
      contextUsage: Math.min(1, Math.max(reportedTokens, est) / runtime.contextWindow()),
    };
    this.deps.notify(Notifications.threadTokenUsage, { threadId: runtime.threadId, usage });
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { _raw: s };
  }
}
