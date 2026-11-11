import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ResponsesAdapter,
  toResponsesWire,
  toChatWireMessages,
  BUILTIN_PROVIDERS,
  type ModelDelta,
  type ChatMessage,
} from '../src/index.js';
import { officialModels } from '../src/models/profiles.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  while (servers.length) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('OpenAI Responses API adapter & prompt cache / thinking wire rules', () => {
  it('converts system, user, assistant tool calls, and tool outputs to Responses wire format', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Follow repository guidelines.' },
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: 'Checking package.json',
        reasoningContent: 'Need to inspect manifest',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"package.json"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'read', content: '{"name":"demo"}' },
    ];
    const wire = toResponsesWire(messages);
    expect(wire.instructions).toContain('Follow repository guidelines.');
    expect(wire.input).toHaveLength(4);
    expect(wire.input[0]).toMatchObject({ role: 'user' });
    expect(wire.input[2]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"package.json"}',
    });
    expect(wire.input[3]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"name":"demo"}',
    });
  });

  it('streams text, reasoning summary, function_call arguments, and cached token usage from /v1/responses SSE', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const srv = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: Record<string, unknown>) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      };
      send('response.reasoning_summary_text.delta', { delta: 'Analyzing repo...' });
      send('response.output_text.delta', { delta: 'Let me check ' });
      send('response.output_text.delta', { delta: 'the file.' });
      send('response.output_item.added', {
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read' },
      });
      send('response.function_call_arguments.delta', {
        output_index: 1,
        item_id: 'fc_1',
        delta: '{"path":',
      });
      send('response.function_call_arguments.delta', {
        output_index: 1,
        item_id: 'fc_1',
        delta: '"README.md"}',
      });
      send('response.output_item.done', {
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'read',
          arguments: '{"path":"README.md"}',
        },
      });
      send('response.completed', {
        response: {
          status: 'completed',
          usage: {
            input_tokens: 1200,
            output_tokens: 85,
            input_tokens_details: { cached_tokens: 960 },
          },
        },
      });
      res.end();
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as AddressInfo).port;

    const adapter = new ResponsesAdapter({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
    });
    const deltas: ModelDelta[] = [];
    for await (const d of adapter.stream({
      model: 'gpt-5.3-codex',
      messages: [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Inspect README' },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
      reasoningEffort: 'high',
      promptCacheKey: 'th_cache_1',
    })) {
      deltas.push(d);
    }

    expect(capturedBody).toMatchObject({
      model: 'gpt-5.3-codex',
      prompt_cache_key: 'th_cache_1',
      reasoning: { effort: 'high', summary: 'auto' },
    });
    expect(deltas.filter((d) => d.type === 'reasoning').map((d) => d.text).join('')).toBe('Analyzing repo...');
    expect(deltas.filter((d) => d.type === 'text').map((d) => d.text).join('')).toBe('Let me check the file.');
    const start = deltas.find((d) => d.type === 'toolCallStart');
    expect(start).toEqual({ type: 'toolCallStart', id: 'call_abc', name: 'read' });
    const argDeltas = deltas
      .filter((d): d is Extract<ModelDelta, { type: 'toolCallDelta' }> => d.type === 'toolCallDelta')
      .map((d) => d.argsDelta)
      .join('');
    expect(argDeltas).toBe('{"path":"README.md"}');
    const usage = deltas.find((d) => d.type === 'usage');
    expect(usage).toMatchObject({
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 85,
      cachedInputTokens: 960,
    });
    expect(deltas.at(-1)).toEqual({ type: 'done', finishReason: 'toolCalls' });
  });

  it('strips prior-turn reasoning_content while preserving active-turn DeepSeek thinking tool chains', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Turn 1 question' },
      { role: 'assistant', content: 'Turn 1 answer', reasoningContent: 'Old turn 1 CoT that must be stripped' },
      { role: 'user', content: 'Turn 2 question' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'Active turn 2 CoT before tool call',
        toolCalls: [{ id: 'tc_2', name: 'glob', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'tc_2', name: 'glob', content: 'src/index.ts' },
    ];
    const wire = toChatWireMessages(history) as Array<Record<string, unknown>>;
    expect(wire[1]?.reasoning_content).toBeUndefined();
    expect(wire[3]?.reasoning_content).toBe('Active turn 2 CoT before tool call');
  });

  it('unlocks gpt-5.3-codex and gpt-6.1-sol with preferredWire="responses" in official catalog', () => {
    const models = officialModels(BUILTIN_PROVIDERS.openai);
    const codex = models.find((m) => m.id === 'gpt-5.3-codex');
    const sol = models.find((m) => m.id === 'gpt-6.1-sol');
    expect(codex?.unavailableReason).toBeUndefined();
    expect(codex?.preferredWire).toBe('responses');
    expect(sol?.unavailableReason).toBeUndefined();
    expect(sol?.preferredWire).toBe('responses');
  });
});
