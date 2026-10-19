/**
 * Compactor — keeps long threads alive by replacing old turns with a summary.
 *
 * Trigger: estimated (or reported) token usage over a fraction of the context
 * window. Estimation is the floor, provider-reported usage the ceiling — so
 * compaction fires even when a backend reports no usage at all.
 *
 * A failed model summary may shorten old tool outputs, but never discards
 * user instructions, tool call/result pairs or the recent working tail.
 */

import type { ModelStreamer } from '../models/types.js';
import { estimateHistoryTokens, estimateTokens, ModelError, type ChatMessage } from '../models/types.js';
import { budgetToolOutput } from '../util.js';
import type { HookBus } from '../hooks/bus.js';
import type { ModelRef } from '../config/settings.js';

export interface CompactOptions {
  enabled: boolean;
  threshold: number;
  keepMessages: number;
  maxConsecutive: number;
  contextWindow: number;
}

export interface CompactResult {
  compacted: boolean;
  history: ChatMessage[];
  summary?: string;
  reason?: string;
  method?: 'model' | 'toolOutputs';
  beforeTokens?: number;
  afterTokens?: number;
}

const SUMMARY_PROMPT = `Summarize the earlier part of this coding-agent conversation so work can continue with no loss of task-critical information.
Keep, as terse bullets:
- the user's actual goal and constraints
- decisions made and rejected alternatives
- files touched (paths) and their purpose in the task
- open threads / unfinished steps
Drop greetings, tool noise, and anything superseded. Reply with the summary only.`;

export class Compactor {
  private consecutive = 0;
  private retryAt?: { tokens: number; window: number };
  lastFailure?: string;

  constructor(
    private readonly gateway: ModelStreamer,
    private readonly hooks: HookBus,
    private readonly opts: CompactOptions,
  ) {}

  resetConsecutive(): void {
    this.consecutive = 0;
    this.lastFailure = undefined;
    this.retryAt = undefined;
  }

  /** tokens currently estimated for the history */
  estimate(history: ChatMessage[], reportedTokens?: number): number {
    const est = estimateHistoryTokens(history);
    return Math.max(est, reportedTokens ?? 0);
  }

  needsCompaction(history: ChatMessage[], reportedTokens?: number, contextWindow?: number, overhead = 0): boolean {
    if (!this.opts.enabled) return false;
    if (this.consecutive >= this.opts.maxConsecutive) return false;
    const window = contextWindow ?? this.opts.contextWindow;
    const pressure = Math.max(this.estimate(history) + overhead, reportedTokens ?? 0);
    if (this.retryAt?.window === window && pressure < this.retryAt.tokens && !this.lacksHeadroom(history, reportedTokens, window, overhead)) return false;
    return pressure > window * this.opts.threshold;
  }

  /** A failed proactive summary alone is not a reason to stop a usable task. */
  lacksHeadroom(history: ChatMessage[], reportedTokens = 0, window = this.opts.contextWindow, overhead = 0): boolean {
    const reserve = Math.min(8192, Math.max(512, Math.floor(window * .06)));
    return Math.max(this.estimate(history) + overhead, reportedTokens) >= window - reserve;
  }

  get exhausted(): boolean { return this.consecutive >= this.opts.maxConsecutive; }
  get enabled(): boolean { return this.opts.enabled; }
  get contextWindow(): number { return this.opts.contextWindow; }
  setContextWindow(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) throw new Error('模型返回的上下文窗口无效');
    this.opts.contextWindow = tokens;
  }
  thresholdTokens(window = this.opts.contextWindow): number { return Math.floor(window * this.opts.threshold); }

  async compact(
    history: ChatMessage[],
    ref: ModelRef,
    signal?: AbortSignal,
    contextWindow = this.opts.contextWindow,
    requestTokens = this.estimate(history),
  ): Promise<CompactResult> {
    await this.hooks.emit('PreCompact', { tokens: this.estimate(history) });

    const keep = Math.min(this.opts.keepMessages, history.length);
    // never split a tool pair: extend `keep` while the boundary is unbalanced
    let cut = history.length - keep;
    while (cut > 0 && history[cut]?.role === 'tool') cut--;
    // Message count alone can retain an enormous tail and trigger a loop.
    while (cut < history.length - 2 && this.estimate(history.slice(cut)) > contextWindow * .35) {
      let next = cut + 1;
      while (next < history.length && history[next]?.role === 'tool') next++;
      if (next > history.length - 2) break;
      cut = next;
    }
    if (cut <= 0) return this.failed(history, cut, '近期记录尚不能形成可压缩的完整片段', contextWindow, requestTokens);

    const system = history.filter((m) => m.role === 'system');
    const old = history.slice(0, cut).filter((m) => m.role !== 'system');
    const tail = history.slice(cut).filter(m => m.role !== 'system');

    let summary: string | undefined;
    try {
      summary = await this.summarize(old, ref, contextWindow, signal);
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Interrupted', 'AbortError');
      let reason = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelError && err.body) {
        try { const body = JSON.parse(err.body); const detail = body.error?.message ?? body.message; if (typeof detail === 'string') reason += ': ' + detail.slice(0, 500); } catch { /* HTML/error body is not a user-facing diagnostic. */ }
      }
      return this.failed(history, cut, reason, contextWindow, requestTokens);
    }

    const newHistory: ChatMessage[] = [
      ...system,
      { role: 'user', content: `<conversation-summary>\n${summary}\n</conversation-summary>\n(earlier messages were compacted; continue from here)` },
      ...tail,
    ];
    const gain = this.estimate(history) - this.estimate(newHistory);
    if (gain <= 0 || this.estimate(newHistory) > this.thresholdTokens(contextWindow) && gain < Math.min(contextWindow * .05, this.estimate(history) * .1)) {
      return this.failed(history, cut, '模型生成的摘要未能有效释放上下文', contextWindow, requestTokens);
    }
    this.resetConsecutive();

    await this.hooks.emit('PostCompact', { summary });
    return { compacted: true, history: newHistory, summary, method: 'model', beforeTokens: this.estimate(history), afterTokens: this.estimate(newHistory) };
  }

  private failed(history: ChatMessage[], cut: number, reason: string, window: number, requestTokens: number): CompactResult {
    this.lastFailure = reason.slice(0, 2000);
    const beforeTokens = this.estimate(history);
    // Only verbose early tool output is shortened. Full UI/log records stay
    // intact; the model receives an explicit marker and can reread source files.
    const reduced = history.map((m, i): ChatMessage => i < cut && m.role === 'tool' && m.content.length > 3000
      ? { ...m, content: budgetToolOutput(m.content, 2800) + '\n[早期工具输出已精简；完整输出保留在执行记录中，需要源文件内容时请按原路径重新读取。]' }
      : m);
    const afterTokens = this.estimate(reduced);
    if (afterTokens < beforeTokens * .9) {
      this.consecutive = 0;
      this.retryAt = { window, tokens: requestTokens - beforeTokens + afterTokens + Math.ceil(window * .05) };
      return { compacted: true, history: reduced, method: 'toolOutputs', summary: '仅精简早期工具输出，保留用户指令、调用关系和近期记录。', reason: this.lastFailure, beforeTokens, afterTokens };
    }
    this.consecutive++;
    // Retry only after meaningful new input, or immediately if space is exhausted.
    this.retryAt = { window, tokens: requestTokens + Math.ceil(window * .05) };
    return { compacted: false, history, reason: this.lastFailure, beforeTokens, afterTokens: beforeTokens };
  }

  private async summarize(messages: ChatMessage[], ref: ModelRef, contextWindow: number, signal?: AbortSignal): Promise<string> {
    let transcript = messages
      .map((m) => {
        if (m.role === 'system') return `[system] ${m.content}`;
        if (m.role === 'user') return `[user] ${snippet(m)}`;
        if (m.role === 'assistant') {
          const tools = m.toolCalls?.map((tc) => `[tool ${tc.name}] ${tc.arguments}`).join(' ') ?? '';
          return `[assistant] ${m.content ?? ''}${tools}`.trim();
        }
        return `[tool-result] ${budgetToolOutput(m.content, 1600)}`;
      })
      .join('\n');
    const transcriptBudget = Math.max(128, Math.floor(contextWindow * .55) - estimateTokens(SUMMARY_PROMPT));
    while (transcript.length > 60_000 || estimateTokens(transcript) > transcriptBudget) {
      transcript = budgetToolOutput(transcript, Math.max(64, Math.floor(transcript.length * .7)));
    }
    const request: ChatMessage[] = [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
    ];
    const available = Math.max(64, contextWindow - estimateHistoryTokens(request) - 128);
    // Reasoning models can consume the old 1024-token allowance before
    // producing any answer. Increase once only for a clearly truncated reply.
    for (let attempt = 0; attempt < 2; attempt++) {
      const maxOutputTokens = Math.min(attempt ? 8192 : 4096, available);
      let out = '', reasoning = false, finish: string | undefined;
      for await (const delta of this.gateway.stream(ref, { messages: request, tools: [], maxOutputTokens, signal })) {
        if (delta.type === 'text') out += delta.text;
        if (delta.type === 'reasoning') reasoning = true;
        if (delta.type === 'done') finish = delta.finishReason;
      }
      if (finish === 'length' || !out.trim() && reasoning) {
        if (!attempt && available > maxOutputTokens) continue;
        throw new Error('摘要输出预算耗尽，模型未返回完整摘要（可能只生成了思考内容）');
      }
      if (finish === 'contentFilter') throw new Error('模型服务过滤了摘要响应');
      if (!out.trim()) throw new Error('模型返回空摘要，原始记录已保留');
      return out.trim();
    }
    throw new Error('模型未返回可用摘要');
  }
}

function snippet(m: Extract<ChatMessage, { role: 'user' }>): string {
  if (typeof m.content === 'string') return budgetToolOutput(m.content, 8000);
  return m.content
    .map((p) => (p.type === 'text' ? p.text : '[image]'))
    .join(' ')
    .slice(0, 8000);
}
