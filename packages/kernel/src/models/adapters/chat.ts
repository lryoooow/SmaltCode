/**
 * OpenAI-compatible Chat Completions adapter (wire: 'chat').
 *
 * Works with OpenAI, DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen,
 * OpenRouter, Ollama, vLLM, LM Studio, and anything else speaking the
 * `/chat/completions` dialect. Reasoning streams via the de-facto
 * `reasoning_content` delta field are supported transparently.
 *
 * Usage accounting: the request asks for `stream_options.include_usage`,
 * and if a backend rejects that with HTTP 400 it retries once without it
 * (some OpenAI-compatible servers don't know the field). Crucially, the
 * stream is read to the end before `done` is emitted — OpenAI sends the
 * usage chunk AFTER the finish_reason chunk.
 */

import { parseRetryAfterMs, parseSse, readErrorBody } from '../sse.js';
import {
  ModelError,
  type ChatMessage,
  type ModelAdapter,
  type ModelDelta,
  type ModelRequest,
} from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ChatToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatAdapterOptions {
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  fetchImpl?: typeof fetch;
  /** set false for backends that 400 on stream_options without retry */
  streamUsage?: boolean;
  stallTimeoutMs?: number;
}

function extractChatUsage(raw: any): Extract<ModelDelta, { type: 'usage' }> {
  const inputTokens = raw?.prompt_tokens ?? 0;
  const outputTokens = raw?.completion_tokens ?? 0;
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens;
  const cacheWrite = raw?.prompt_cache_miss_tokens;
  return {
    type: 'usage',
    inputTokens,
    outputTokens,
    ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(typeof cacheWrite === 'number' && cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {}),
  };
}

export function toChatWireMessages(messages: ChatMessage[], includeActiveEmptyReasoning = false): unknown[] {
  const out: any[] = [];
  // some backends only accept a single system message — merge them
  const systemTexts: string[] = [];
  // Keep reasoning_content only within the active user turn's tool chain (DeepSeek/OpenAI hygiene):
  // assistant messages from completed prior user turns strip reasoning_content to save context and avoid 400s.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx]!;
    if (m.role === 'system') {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) =>
              p.type === 'text'
                ? { type: 'text', text: p.text }
                : {
                    type: 'image_url',
                    image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
                  },
            );
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content ?? null };
      if (idx > lastUserIdx && (m.reasoningContent || (includeActiveEmptyReasoning && m.toolCalls?.length))) {
        msg.reasoning_content = m.reasoningContent ?? '';
      }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }));
      }
      out.push(msg);
    } else {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  if (systemTexts.length) {
    out.unshift({ role: 'system', content: systemTexts.join('\n\n') });
  }
  return out;
}

export class ChatCompletionsAdapter implements ModelAdapter {
  readonly wire = 'chat' as const;

  constructor(private readonly opts: ChatAdapterOptions) {}

  get capabilities() {
    return {
      tools: true,
      reasoning: true,
      images: true,
      contextWindow: this.opts.contextWindow ?? 128_000,
    };
  }

  private async doRequest(body: Record<string, unknown>, req: ModelRequest): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
    };

    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
        redirect: 'error',
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || req.signal?.aborted) throw err;
      throw new ModelError(
        `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Some OpenAI-compatible backends reject unknown stream_options / reasoning_effort / prompt_cache_key with 400.
    if (res.status === 400 && ('stream_options' in body || 'reasoning_effort' in body || 'prompt_cache_key' in body)) {
      const errBody = await readErrorBody(res.clone());
      const stripStream = 'stream_options' in body && /stream_options/i.test(errBody);
      const stripEffort = 'reasoning_effort' in body && /reasoning_effort/i.test(errBody);
      const stripCacheKey = 'prompt_cache_key' in body && /prompt_cache_key/i.test(errBody);
      if (stripStream || stripEffort || stripCacheKey) {
        const retryBody = { ...body };
        if (stripStream) delete retryBody.stream_options;
        if (stripEffort) delete retryBody.reasoning_effort;
        if (stripCacheKey) delete retryBody.prompt_cache_key;
        void res.body?.cancel().catch(() => {});
        try {
          res = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(retryBody),
            signal: req.signal,
            redirect: 'error',
          });
        } catch (err) {
          throw new ModelError(
            `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
    return res;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelDelta> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toChatWireMessages(req.messages, Boolean(req.reasoningEffort)),
      stream: true,
    };
    if (this.opts.streamUsage !== false) {
      body.stream_options = { include_usage: true };
    }
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const endpoint = (() => { try { return new URL(this.opts.baseUrl); } catch { return null; } })();
    const isOpenAI = endpoint?.origin === 'https://api.openai.com' && /^\/(?:v1)\/?$/.test(endpoint.pathname);
    if (req.reasoningEffort) {
      body.reasoning_effort = req.reasoningEffort === 'max' && isOpenAI ? 'high' : req.reasoningEffort;
    }
    if (req.promptCacheKey && isOpenAI) {
      body.prompt_cache_key = req.promptCacheKey;
    }
    if (req.maxOutputTokens) {
      const modernOpenAI = isOpenAI && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/.test(req.model);
      body[modernOpenAI ? 'max_completion_tokens' : 'max_tokens'] = req.maxOutputTokens;
    }

    const res = await this.doRequest(body, req);
    if (!res.body) {
      throw new ModelError('Model API returned an empty body');
    }

    const toolCallsByIndex = new Map<number, { id: string; syntheticId: boolean; emittedStart: boolean; name: string; args: string }>();
    let emittedToolCall = false;
    let finishReason: string | null = null;
    let usage: Extract<ModelDelta, { type: 'usage' }> | null = null;

    for await (const data of parseSse(res.body, req.signal, { stallTimeoutMs: this.opts.stallTimeoutMs })) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        // usage-only chunk (arrives after finish_reason when include_usage)
        if (chunk.usage) {
          usage = extractChatUsage(chunk.usage);
        }
        continue;
      }
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        yield { type: 'reasoning', text: delta.reasoning_content };
      }
      if (typeof delta.reasoning === 'string' && delta.reasoning) {
        yield { type: 'reasoning', text: delta.reasoning };
      }
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as ChatToolCallDelta[]) {
          const rawId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : undefined;
          // Providers omitting index must identify parallel calls by ID. A
          // lone ID-less continuation is safe only when exactly one call exists.
          let index = tc.index;
          if (index === undefined) {
            const identified = rawId ? [...toolCallsByIndex].find(([, call]) => call.id === rawId) : undefined;
            if (identified) index = identified[0];
            else if (rawId) { index = 0; while (toolCallsByIndex.has(index)) index++; }
            else if (toolCallsByIndex.size === 1) index = toolCallsByIndex.keys().next().value!;
            else if (toolCallsByIndex.size === 0 && delta.tool_calls.length === 1) index = 0;
            else throw new ModelError('Ambiguous tool-call stream: parallel calls require index or id');
          }
          if (!Number.isSafeInteger(index) || index < 0) throw new ModelError('Invalid tool-call index');
          const existing = toolCallsByIndex.get(index);
          if (existing && rawId && existing.id !== rawId) {
            if (existing.syntheticId && !existing.emittedStart) {
              existing.id = rawId;
              existing.syntheticId = false;
            } else if (!existing.syntheticId) {
              throw new ModelError('Tool-call identity changed during streaming');
            }
          }
          if (!existing) {
            const id = rawId ?? `call_${index}`;
            const name = tc.function?.name ?? '';
            const args = tc.function?.arguments ?? '';
            const emittedStart = Boolean(name);
            toolCallsByIndex.set(index, { id, syntheticId: !rawId, emittedStart, name, args });
            if (name) {
              yield { type: 'toolCallStart', id, name };
              emittedToolCall = true;
            }
            // some backends deliver id+name+arguments in ONE chunk — don't lose them
            if (args) {
              yield { type: 'toolCallDelta', id, argsDelta: args };
            }
          } else {
            if (tc.function?.name && !existing.name) {
              existing.name = tc.function.name;
              existing.emittedStart = true;
              yield { type: 'toolCallStart', id: existing.id, name: existing.name };
              emittedToolCall = true;
            }
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
              yield { type: 'toolCallDelta', id: existing.id, argsDelta: tc.function.arguments };
            }
          }
        }
      }
      if (choice.usage || chunk.usage) {
        usage = extractChatUsage(choice.usage ?? chunk.usage);
      }
      if (choice.finish_reason && !finishReason) {
        finishReason = choice.finish_reason;
        // keep reading: the usage chunk may still arrive
      }
    }

    if (!finishReason) throw new ModelError('Model stream ended before a completion marker');
    if (usage) yield usage;
    const finish =
      finishReason === 'tool_calls' || (emittedToolCall && (!finishReason || finishReason === 'stop'))
        ? 'toolCalls'
        : finishReason === 'length'
          ? 'length'
          : finishReason === 'content_filter'
            ? 'contentFilter'
            : finishReason === 'stop'
              ? 'stop'
              : 'other';
    yield { type: 'done', finishReason: finish };
  }
}
