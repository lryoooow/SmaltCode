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

import { parseSse, readErrorBody } from '../sse.js';
import {
  ModelError,
  type ChatMessage,
  type ModelAdapter,
  type ModelDelta,
  type ModelRequest,
} from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ChatToolCallDelta {
  index: number;
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
}

export function toChatWireMessages(messages: ChatMessage[]): unknown[] {
  const out: any[] = [];
  // some backends only accept a single system message — merge them
  const systemTexts: string[] = [];
  for (const m of messages) {
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
      if (m.reasoningContent) msg.reasoning_content = m.reasoningContent;
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
      });
    } catch (err) {
      throw new ModelError(
        `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Some OpenAI-compatible backends reject unknown stream_options with 400.
    if (res.status === 400 && 'stream_options' in body) {
      const retryBody = { ...body };
      delete retryBody.stream_options;
      void res.body?.cancel().catch(() => {});
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal: req.signal,
        });
      } catch (err) {
        throw new ModelError(
          `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!res.ok || !res.body) {
      throw new ModelError(
        `Model API error (HTTP ${res.status})`,
        res.status,
        await readErrorBody(res),
      );
    }
    return res;
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelDelta> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toChatWireMessages(req.messages),
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
    if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;

    const res = await this.doRequest(body, req);
    if (!res.body) {
      throw new ModelError('Model API returned an empty body');
    }

    const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
    let emittedToolCall = false;
    let finishReason: string | null = null;
    let usage: { type: 'usage'; inputTokens: number; outputTokens: number } | null = null;

    for await (const data of parseSse(res.body, req.signal)) {
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
          usage = {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
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
          const existing = toolCallsByIndex.get(tc.index);
          if (!existing) {
            const id = tc.id ?? `call_${tc.index}`;
            const name = tc.function?.name ?? '';
            const args = tc.function?.arguments ?? '';
            toolCallsByIndex.set(tc.index, { id, name, args });
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
      if (choice.usage) {
        usage = {
          type: 'usage',
          inputTokens: choice.usage.prompt_tokens ?? 0,
          outputTokens: choice.usage.completion_tokens ?? 0,
        };
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
