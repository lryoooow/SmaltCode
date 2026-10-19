import { describe, expect, it } from 'vitest';
import { ChatCompletionsAdapter } from '../src/models/adapters/chat.js';
import type { ChatMessage, ModelDelta } from '../src/models/types.js';

function sseResponse(chunks: unknown[], status = 200): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

function adapter(fetchImpl: typeof fetch) {
  return new ChatCompletionsAdapter({
    baseUrl: 'https://fake.test/v1',
    apiKey: 'k',
    fetchImpl,
  });
}

async function collect(gen: AsyncIterable<ModelDelta>): Promise<ModelDelta[]> {
  const out: ModelDelta[] = [];
  for await (const d of gen) out.push(d);
  return out;
}
it('uses the modern OpenAI output limit parameter without changing other compatible providers', async () => {
  for (const [baseUrl, field] of [['https://api.openai.com/v1', 'max_completion_tokens'], ['https://proxy.example/v1', 'max_tokens']]) {
    let sent: any;
    const model = new ChatCompletionsAdapter({ baseUrl: baseUrl!, apiKey: 'test', fetchImpl: (async (_url, request) => { sent = JSON.parse(String(request?.body)); return sseResponse([{ choices: [{ delta: { content: 'summary' }, finish_reason: 'stop' }] }]); }) as typeof fetch });
    await collect(model.stream({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'summarize' }], tools: [], maxOutputTokens: 4096 }));
    expect(sent[field!]).toBe(4096); expect(sent[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
  }
});

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('ChatCompletionsAdapter', () => {
  it('does not retry unrelated 400s and prevents provider HTTP redirects', async () => {
    let requests = 0;
    const a = adapter(async (_url, init) => { requests++; expect(init?.redirect).toBe('error'); return new Response('context window exceeded', { status: 400 }); });
    await expect(collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }))).rejects.toMatchObject({ status: 400 });
    expect(requests).toBe(1);
  });
  it('keeps index-less parallel calls separate using stable IDs', async () => {
    const a = adapter(async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{' } }, { id: 'b', function: { name: 'read', arguments: '{' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'b', function: { arguments: '"path":"b"}' } }, { id: 'a', function: { arguments: '"path":"a"}' } }] }, finish_reason: 'tool_calls' }] },
    ]));
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    for (const id of ['a', 'b']) expect(deltas.filter(d => d.type === 'toolCallDelta' && d.id === id).map(d => (d as any).argsDelta).join('')).toBe(`{"path":"${id}"}`);
  });
  it('rejects ambiguous index-less continuations instead of merging tools', async () => {
    const a = adapter(async () => sseResponse([
      { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'read' } }, { id: 'b', function: { name: 'read' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ]));
    await expect(collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }))).rejects.toThrow('Ambiguous');
  });
  it('streams text and maps finish_reason stop', async () => {
    const a = adapter(async () =>
      sseResponse([
        { choices: [{ delta: { content: 'Hello' }, index: 0 }] },
        { choices: [{ delta: { content: ' world' }, index: 0 }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] },
      ]),
    );
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    expect(deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('Hello world');
    expect(deltas[deltas.length - 1]).toMatchObject({ type: 'done', finishReason: 'stop' });
  });

  it('assembles streaming tool calls and maps finish to toolCalls', async () => {
    const a = adapter(async () =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '' } }] }, index: 0 }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x' } }] }, index: 0 }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }, index: 0 }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] },
      ]),
    );
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    expect(deltas).toContainEqual({ type: 'toolCallStart', id: 'c1', name: 'read' });
    const args = deltas
      .filter((d) => d.type === 'toolCallDelta')
      .map((d) => (d as { argsDelta: string }).argsDelta)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'x.ts' });
    expect(deltas[deltas.length - 1]).toMatchObject({ type: 'done', finishReason: 'toolCalls' });
  });

  it('captures usage arriving AFTER the finish_reason chunk (regression)', async () => {
    const a = adapter(async () =>
      sseResponse([
        { choices: [{ delta: { content: 'ok' }, index: 0 }] },
        { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
      ]),
    );
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    const usage = deltas.find((d) => d.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 42, outputTokens: 7 });
    // done must come after usage
    expect(deltas.findIndex((d) => d.type === 'usage')).toBeLessThan(
      deltas.findIndex((d) => d.type === 'done'),
    );
  });

  it('sends stream_options.include_usage and retries without it on 400', async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const a = adapter(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      call++;
      if (call === 1) {
        return new Response('{"error":{"message":"unknown field stream_options"}}', { status: 400 });
      }
      return sseResponse([{ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: 'stop' }] }]);
    });
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    expect(deltas[deltas.length - 1]).toMatchObject({ type: 'done' });
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as Record<string, unknown>).stream_options).toEqual({ include_usage: true });
    expect((bodies[1] as Record<string, unknown>).stream_options).toBeUndefined();
  });

  it('surfaces reasoning_content as reasoning deltas', async () => {
    const a = adapter(async () =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: 'thinking…' }, index: 0 }] },
        { choices: [{ delta: { content: 'answer' }, index: 0, finish_reason: 'stop' }] },
      ]),
    );
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    expect(deltas).toContainEqual({ type: 'reasoning', text: 'thinking…' });
  });

  it('raises ModelError with status and body on HTTP errors', async () => {
    const a = adapter(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }))).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it('maps finish_reason length', async () => {
    const a = adapter(async () =>
      sseResponse([{ choices: [{ delta: { content: 'x' }, index: 0, finish_reason: 'length' }] }]),
    );
    const deltas = await collect(a.stream({ model: 'm', messages: MESSAGES, tools: [] }));
    expect(deltas[deltas.length - 1]).toMatchObject({ type: 'done', finishReason: 'length' });
  });
});
