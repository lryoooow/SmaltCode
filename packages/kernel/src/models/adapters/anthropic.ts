/**
 * Anthropic Messages adapter (wire: 'anthropic').
 *
 * Speaks the native `/v1/messages` SSE protocol, including interleaved
 * thinking blocks and tool_use assembly.
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

export interface AnthropicAdapterOptions {
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  fetchImpl?: typeof fetch;
}

function toAnthropicWire(messages: ChatMessage[]): { system?: string; messages: unknown[] } {
  const systemTexts: string[] = [];
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.content);
    } else if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) =>
              p.type === 'text'
                ? { type: 'text', text: p.text }
                : {
                    type: 'image',
                    source: { type: 'base64', media_type: p.mimeType, data: p.dataBase64 },
                  },
            );
      // merge consecutive user messages (Anthropic requires alternation)
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && typeof prev.content === 'string' && typeof content === 'string') {
        prev.content = `${prev.content}\n\n${content}`;
      } else {
        out.push({ role: 'user', content });
      }
    } else if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeParseJson(tc.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else {
      // tool result → user turn with tool_result blocks
      const prev = out[out.length - 1];
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        is_error: m.isError ?? false,
      };
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return {
    system: systemTexts.length ? systemTexts.join('\n\n') : undefined,
    messages: out,
  };
}

function safeParseJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { _raw: s };
  }
}

export class AnthropicAdapter implements ModelAdapter {
  readonly wire = 'anthropic' as const;

  constructor(private readonly opts: AnthropicAdapterOptions) {}

  get capabilities() {
    return {
      tools: true,
      reasoning: true,
      images: true,
      contextWindow: this.opts.contextWindow ?? 200_000,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelDelta> {
    const wire = toAnthropicWire(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 8192,
      messages: wire.messages,
      stream: true,
    };
    if (wire.system) body.system = wire.system;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new ModelError(
        `Request to ${this.opts.baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok || !res.body) {
      throw new ModelError(
        `Model API error (HTTP ${res.status})`,
        res.status,
        await readErrorBody(res),
      );
    }

    let inputUsage = 0;
    let outputUsage = 0;
    let finish: 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other' = 'stop';
    let sawToolUse = false;
    /** index of the content block currently being assembled */
    let blockIndex = -1;
    const toolIdByBlock = new Map<number, string>();

    for await (const data of parseSse(res.body, req.signal)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          inputUsage = ev.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start': {
          blockIndex = ev.index ?? blockIndex + 1;
          const block = ev.content_block;
          if (block?.type === 'tool_use') {
            sawToolUse = true;
            toolIdByBlock.set(blockIndex, block.id);
            yield { type: 'toolCallStart', id: block.id, name: block.name ?? '' };
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (d?.type === 'text_delta' && d.text) {
            yield { type: 'text', text: d.text };
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            yield { type: 'reasoning', text: d.thinking };
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const id = toolIdByBlock.get(ev.index ?? blockIndex);
            if (id) yield { type: 'toolCallDelta', id, argsDelta: d.partial_json };
          }
          break;
        }
        case 'message_delta': {
          if (ev.usage?.output_tokens) outputUsage = ev.usage.output_tokens;
          if (ev.delta?.stop_reason === 'tool_use') finish = 'toolCalls';
          else if (ev.delta?.stop_reason === 'max_tokens') finish = 'length';
          else if (ev.delta?.stop_reason === 'stop_sequence') finish = 'stop';
          break;
        }
        case 'message_stop': {
          yield { type: 'usage', inputTokens: inputUsage, outputTokens: outputUsage };
          yield {
            type: 'done',
            finishReason: finish === 'stop' && sawToolUse ? 'toolCalls' : finish,
          };
          return;
        }
        case 'error': {
          throw new ModelError(ev.error?.message ?? 'Anthropic stream error', undefined, data);
        }
      }
    }
    yield { type: 'usage', inputTokens: inputUsage, outputTokens: outputUsage };
    yield { type: 'done', finishReason: sawToolUse ? 'toolCalls' : finish };
  }
}
