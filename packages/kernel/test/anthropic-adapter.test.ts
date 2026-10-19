import { describe, it, expect } from 'vitest';
import { AnthropicAdapter, toAnthropicWire } from '../src/models/adapters/anthropic.js';
describe('Anthropic wire message assembly', () => {
  it('uses one v1 segment for both accepted base URL forms', async () => {
    for (const baseUrl of ['https://api.anthropic.com', 'https://api.anthropic.com/v1/']) {
      const adapter = new AnthropicAdapter({ baseUrl, apiKey: 'test', fetchImpl: (async url => { expect(String(url)).toBe('https://api.anthropic.com/v1/messages'); return new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); }) as typeof fetch });
      for await (const _delta of adapter.stream({ model: 'test', messages: [{ role: 'user', content: 'test' }], tools: [] })) { /* consume actual SSE adapter */ }
    }
  });
  it('merges tool results, steering text and images into one ordered user message', () => {
    const wire = toAnthropicWire([
      { role: 'assistant', content: null, toolCalls: [{ id: 'one', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'one', content: 'result' },
      { role: 'user', content: 'new requirement' },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/png', dataBase64: 'fixture' }] },
    ]);
    expect(wire.messages).toHaveLength(2);
    expect(wire.messages[1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one' }, { type: 'text', text: 'new requirement' }, { type: 'image', source: { data: 'fixture' } }] });
  });
});
