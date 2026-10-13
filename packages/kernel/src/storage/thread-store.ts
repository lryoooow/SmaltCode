/**
 * Thread persistence: the conversation body is an append-only JSONL event log
 * (one file per thread); metadata lives in the same file (latest `meta` event
 * wins). Deltas are never persisted — only completed items. A `compacted`
 * event is permanent: replaying applies the history replacement.
 */

import type { ChatMessage, ToolCall } from '../models/types.js';
import type { PlanStep, ThreadMeta } from '../protocol/types.js';

export type { ThreadMeta } from '../protocol/types.js';

export type StoreEvent =
  | { t: 'meta'; meta: ThreadMeta }
  | { t: 'turn-started'; turnId: string; at: string }
  | { t: 'turn-ended'; turnId: string; at: string; interrupted?: boolean }
  | { t: 'user-msg'; id: string; text: string; at: string }
  | { t: 'agent-msg'; id: string; text: string; at: string; status?: import('../protocol/types.js').ItemStatus }
  | { t: 'reasoning'; id: string; text: string; at: string; status?: import('../protocol/types.js').ItemStatus }
  | { t: 'tool-call'; id: string; tool: string; input: unknown; at: string }
  | { t: 'tool-result'; id: string; tool: string; output: string; isError: boolean; at: string; items?: import('../protocol/types.js').Item[] }
  | { t: 'plan'; steps: PlanStep[]; at: string }
  | { t: 'compacted'; summary: string; at: string; history?: ChatMessage[] }
  | { t: 'usage'; inputTokens: number; outputTokens: number; at: string };

export interface ThreadStore {
  append(threadId: string, event: StoreEvent): void;
  load(threadId: string): StoreEvent[] | null;
  listMetas(includeArchived?: boolean): ThreadMeta[];
  exists(threadId: string): boolean;
  archive(threadId: string): boolean;
  restore?(threadId: string): boolean;
  delete?(threadId: string): boolean;
}

export interface ReplayedThread {
  meta: ThreadMeta;
  events: StoreEvent[];
  history: ChatMessage[];
  lastUsage: { inputTokens: number; outputTokens: number };
}

/** Rebuild a working history from the event log. */
export function replayEvents(events: StoreEvent[]): Pick<ReplayedThread, 'history' | 'lastUsage'> {
  const history: ChatMessage[] = [];
  let lastUsage = { inputTokens: 0, outputTokens: 0 };
  let reasoning: string | undefined;

  for (const ev of events) {
    switch (ev.t) {
      case 'user-msg':
        history.push({ role: 'user', content: ev.text });
        break;
      case 'agent-msg':
        history.push({ role: 'assistant', content: ev.text, reasoningContent: reasoning });
        reasoning = undefined;
        break;
      case 'reasoning': reasoning = ev.text; break;
      case 'tool-call': {
        const last = history.at(-1);
        const call = { id: ev.id, name: ev.tool, arguments: safeStringify(ev.input) } as ToolCall;
        if (last?.role === 'assistant') {
          last.toolCalls = [...(last.toolCalls ?? []), call];
        } else history.push({
          role: 'assistant',
          content: null,
          toolCalls: [call],
          reasoningContent: reasoning,
        });
        reasoning = undefined;
        break;
      }
      case 'tool-result':
        history.push({ role: 'tool', toolCallId: ev.id, content: ev.output, isError: ev.isError });
        break;
      case 'compacted':
        history.length = 0;
        if (ev.history) { history.push(...ev.history); break; }
        history.push({
          role: 'user',
          content: `<conversation-summary>\n${ev.summary}\n</conversation-summary>\n(earlier messages were compacted; continue from here)`,
        });
        break;
      case 'usage':
        lastUsage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
        break;
      default:
        break;
    }
  }
  return { history, lastUsage };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
