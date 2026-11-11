/**
 * OpenAI Responses API adapter (wire: 'responses').
 *
 * Speaks the `/v1/responses` SSE protocol required by OpenAI's modern coding
 * and reasoning models (e.g. `gpt-5.3-codex`, `gpt-6.1-sol`), supporting
 * instructions, multimodal input items, function calls, reasoning summaries,
 * `prompt_cache_key`, and cached token accounting.
 */

import { parseRetryAfterMs, parseSseEvents, readErrorBody } from '../sse.js';
import {
  ModelError,
  type ChatMessage,
  type ModelAdapter,
  type ModelDelta,
  type ModelRequest,
} from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ResponsesAdapterOptions {
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  fetchImpl?: typeof fetch;
  stallTimeoutMs?: number;
}

export function toResponsesWire(messages: ChatMessage[]): { instructions?: string; input: unknown[] } {
  const systemTexts: string[] = [];
  const input: any[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? [{ type: 'input_text', text: m.content }]
          : m.content.map((p) =>
              p.type === 'text'
                ? { type: 'input_text', text: p.text }
                : {
                    type: 'input_image',
                    image_url: `data:${p.mimeType};base64,${p.dataBase64}`,
                  },
            );
      input.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        });
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments || '{}',
        });
      }
    } else {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content,
      });
    }
  }

  return {
    instructions: systemTexts.length ? systemTexts.join('\n\n') : undefined,
    input,
  };
}

export class ResponsesAdapter implements ModelAdapter {
  readonly wire = 'responses' as const;

  constructor(private readonly opts: ResponsesAdapterOptions) {}

  get capabilities() {
    return {
      tools: true,
      reasoning: true,
      images: true,
      contextWindow: this.opts.contextWindow ?? 400_000,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelDelta> {
    const wire = toResponsesWire(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      input: wire.input,
      stream: true,
      store: false,
    };
    if (wire.instructions) body.instructions = wire.instructions;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }));
    }
    if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.promptCacheKey) body.prompt_cache_key = req.promptCacheKey;
    if (req.reasoningEffort) {
      body.reasoning = {
        effort: req.reasoningEffort === 'max' ? 'high' : req.reasoningEffort,
        summary: 'auto',
      };
    }

    const doFetch = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/responses') ? base : `${base}/responses`;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
    };

    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new ModelError(
        `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 400 && ('reasoning' in body || 'prompt_cache_key' in body || 'store' in body)) {
      const errBody = await readErrorBody(res.clone());
      if (/reasoning|prompt_cache_key|store/i.test(errBody)) {
        const retryBody = { ...body };
        if (/reasoning/i.test(errBody)) delete retryBody.reasoning;
        if (/prompt_cache_key/i.test(errBody)) delete retryBody.prompt_cache_key;
        if (/store/i.test(errBody)) delete retryBody.store;
        void res.body?.cancel().catch(() => {});
        res = await doFetch(url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(retryBody), signal: req.signal });
      }
    }

    if (!res.ok || !res.body) {
      throw new ModelError(
        `Model API error (HTTP ${res.status})`,
        res.status,
        await readErrorBody(res),
        parseRetryAfterMs(res.headers),
      );
    }

    const callIdByItemId = new Map<string, string>();
    const streamedArgsItems = new Set<string>();
    let sawToolCall = false;
    let finish: 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other' = 'stop';
    let usage: Extract<ModelDelta, { type: 'usage' }> | null = null;
    let completed = false;

    for await (const sse of parseSseEvents(res.body, req.signal, { stallTimeoutMs: this.opts.stallTimeoutMs })) {
      const data = sse.data;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const eventType: string | undefined = ev.type ?? sse.event;

      switch (eventType) {
        case 'response.output_text.delta':
          if (typeof ev.delta === 'string' && ev.delta) {
            yield { type: 'text', text: ev.delta };
          }
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (typeof ev.delta === 'string' && ev.delta) {
            yield { type: 'reasoning', text: ev.delta };
          }
          break;
        case 'response.output_item.added': {
          const item = ev.item;
          if (item?.type === 'function_call') {
            const callId = item.call_id ?? item.id ?? `call_${callIdByItemId.size}`;
            if (item.id) callIdByItemId.set(item.id, callId);
            sawToolCall = true;
            yield { type: 'toolCallStart', id: callId, name: item.name ?? '' };
            if (typeof item.arguments === 'string' && item.arguments) {
              if (item.id) streamedArgsItems.add(item.id);
              yield { type: 'toolCallDelta', id: callId, argsDelta: item.arguments };
            }
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const itemId = ev.item_id as string | undefined;
          const callId = (itemId ? callIdByItemId.get(itemId) : undefined) ?? ev.call_id;
          if (callId && typeof ev.delta === 'string' && ev.delta) {
            if (itemId) streamedArgsItems.add(itemId);
            yield { type: 'toolCallDelta', id: callId, argsDelta: ev.delta };
          }
          break;
        }
        case 'response.output_item.done': {
          const item = ev.item;
          if (item?.type === 'function_call') {
            const itemId = item.id as string | undefined;
            let callId = itemId ? callIdByItemId.get(itemId) : undefined;
            if (!callId) {
              const resolvedId: string = String(item.call_id ?? item.id ?? `call_${callIdByItemId.size}`);
              callId = resolvedId;
              if (itemId) callIdByItemId.set(itemId, resolvedId);
              sawToolCall = true;
              yield { type: 'toolCallStart', id: resolvedId, name: item.name ?? '' };
            }
            if (typeof item.arguments === 'string' && item.arguments && (!itemId || !streamedArgsItems.has(itemId))) {
              yield { type: 'toolCallDelta', id: callId!, argsDelta: item.arguments };
            }
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          completed = true;
          const resp = ev.response ?? {};
          if (resp.usage) {
            const cached = resp.usage.input_tokens_details?.cached_tokens;
            usage = {
              type: 'usage',
              inputTokens: resp.usage.input_tokens ?? 0,
              outputTokens: resp.usage.output_tokens ?? 0,
              ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
            };
          }
          if (eventType === 'response.incomplete' || resp.status === 'incomplete') {
            const reason = resp.incomplete_details?.reason;
            finish = reason === 'content_filter' ? 'contentFilter' : 'length';
          } else if (sawToolCall) {
            finish = 'toolCalls';
          }
          break;
        }
        case 'response.failed':
        case 'error': {
          const msg = ev.response?.error?.message ?? ev.error?.message ?? 'Responses API stream error';
          throw new ModelError(msg, undefined, data);
        }
      }
    }

    if (!completed && !sawToolCall) {
      throw new ModelError('Responses stream ended before response.completed');
    }
    if (usage) yield usage;
    yield { type: 'done', finishReason: sawToolCall && finish === 'stop' ? 'toolCalls' : finish };
  }
}
