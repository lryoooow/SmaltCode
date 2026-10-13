import { describe, it, expect } from 'vitest';
import { Compactor } from '../src/compact/compactor.js';
import { HookBus } from '../src/hooks/bus.js';
import { replayEvents } from '../src/storage/thread-store.js';
import type { ChatMessage, ModelStreamer } from '../src/models/types.js';
const options = { enabled: true, threshold: .8, keepMessages: 2, maxConsecutive: 2, contextWindow: 1000 };
const ref = { provider: 'test', model: 'test' };
describe('compaction preserves usable history', () => {
  it('keeps all results with their shared assistant tool call', async () => {
    const gateway: ModelStreamer = { async *stream() { yield { type: 'text', text: 'summary' }; } };
    const history: ChatMessage[] = [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }, { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }, { id: 'b', name: 'read', arguments: '{}' }] }, { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'b', content: 'B' }, { role: 'user', content: 'continue' }];
    const result = await new Compactor(gateway, new HookBus(), options).compact(history, ref);
    expect(result.history.slice(1)).toEqual(history.slice(2));
    expect(replayEvents([{ t: 'compacted', at: '', summary: result.summary!, history: result.history }]).history).toEqual(result.history);
  });
  it('preserves the entire history when summary generation fails', async () => {
    const gateway: ModelStreamer = { async *stream() { throw new Error('network'); } };
    const history: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: 'important ' + i }));
    const result = await new Compactor(gateway, new HookBus(), options).compact(history, ref);
    expect(result.compacted).toBe(false); expect(result.history).toEqual(history);
  });
});
