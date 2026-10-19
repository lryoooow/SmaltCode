/**
 * Context pipeline — each turn's prompt is assembled by an ordered chain of
 * interceptors instead of one giant buildPrompt(). Adding a context source
 * means adding an interceptor; nothing else changes.
 */

import type { ChatMessage } from '../models/types.js';
import { baseSystemPrompt } from '../core/prompts.js';

export interface TurnContext {
  threadId: string;
  turnId: string;
  cwd: string;
  modelRef: { provider: string; model: string };
  /** persistent history (loaded from the store + this session) */
  history: ChatMessage[];
  /** the assembled prompt messages for this turn (system + history) */
  prompt: ChatMessage[];
  /** user input that started the turn */
  input: string;
  toolNames: string[];
  /** anything an interceptor wants to append to the system prompt */
  systemExtras: string[];
}

export interface ContextInterceptor {
  name: string;
  /** higher runs first */
  priority: number;
  intercept(ctx: TurnContext): Promise<void>;
}

export class ContextPipeline {
  private interceptors: ContextInterceptor[] = [];

  constructor(initial?: ContextInterceptor[]) {
    this.interceptors = [...(initial ?? [])];
  }

  add(interceptor: ContextInterceptor): void {
    this.interceptors.push(interceptor);
  }

  /** Returns the ordered prompt for this turn. */
  async assemble(ctx: TurnContext): Promise<ChatMessage[]> {
    const ordered = [...this.interceptors].sort((a, b) => b.priority - a.priority);
    for (const icpt of ordered) {
      await icpt.intercept(ctx);
    }
    // final assembly: one merged system message + history
    const systemParts: string[] = [];
    const rest: ChatMessage[] = [];
    for (const m of ctx.prompt) {
      if (m.role === 'system') systemParts.push(m.content);
      else rest.push(m);
    }
    const out: ChatMessage[] = [];
    if (systemParts.length) out.push({ role: 'system', content: systemParts.join('\n\n') });
    out.push(...rest);
    return out;
  }
}

/** Builds the base system prompt. */
export function systemInterceptor(): ContextInterceptor {
  return {
    name: 'system',
    priority: 1500,
    async intercept(ctx) {
      ctx.prompt.unshift({
        role: 'system',
        content: baseSystemPrompt({
          cwd: ctx.cwd,
          model: ctx.modelRef.model,
          hasPlanTool: ctx.toolNames.includes('plan'),
        }),
      });
    },
  };
}

/** Injects environment/system-reminder style notices (date, workspace notes). */
export function envInterceptor(now = () => new Date()): ContextInterceptor {
  return {
    name: 'env',
    priority: 2000,
    async intercept(ctx) {
      const date = now();
      const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
      ctx.systemExtras.push(`Current date: ${localDate} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
      ctx.prompt.unshift({ role: 'system', content: '<system-info>' + ctx.systemExtras.join('\n') + '</system-info>' });
    },
  };
}
