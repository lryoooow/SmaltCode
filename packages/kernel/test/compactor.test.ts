import { describe, it, expect } from 'vitest';
import { Compactor } from '../src/compact/compactor.js';
import { HookBus } from '../src/hooks/bus.js';
import { replayEvents } from '../src/storage/thread-store.js';
import type { ChatMessage, ModelStreamer } from '../src/models/types.js';
const options = { enabled: true, threshold: .8, keepMessages: 2, maxConsecutive: 2, contextWindow: 1000 };
const ref = { provider: 'test', model: 'test' };
describe('compaction preserves usable history', () => {
  it('does not compact 10K, 100K or 256K inputs in a 1M model window', () => {
    const compactor = new Compactor({ async *stream() {} }, new HookBus(), { ...options, contextWindow: 1_000_000 });
    for (const tokens of [10_000, 100_581, 256_000, 799_999]) expect(compactor.needsCompaction([], tokens)).toBe(false);
    expect(compactor.needsCompaction([], 800_001)).toBe(true);
    expect(compactor.needsCompaction([], 10_000, 16_000)).toBe(false);
    expect(compactor.needsCompaction([], 13_000, 16_000)).toBe(true);
  });
  it('does not repeat an unchanged failed proactive summary until input grows, but retries at real capacity pressure', async () => {
    const compactor = new Compactor({ async *stream() { throw new Error('offline'); } }, new HookBus(), { ...options, contextWindow: 100_000 });
    const history: ChatMessage[] = Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(16_000) }));
    const tokens = compactor.estimate(history);
    expect(compactor.needsCompaction(history)).toBe(true);
    expect((await compactor.compact(history, ref)).compacted).toBe(false);
    expect(compactor.needsCompaction(history)).toBe(false);
    expect(compactor.needsCompaction(history, tokens + 4999)).toBe(false);
    expect(compactor.needsCompaction(history, tokens + 5000)).toBe(true);
    expect(compactor.needsCompaction(history, 94_000)).toBe(true);
  });
  it('increases the summary budget when reasoning consumes the first reply, and rejects truncated summaries', async () => {
    const requests: number[] = [];
    const gateway: ModelStreamer = { async *stream(_ref, request) {
      requests.push(request.maxOutputTokens!);
      if (requests.length === 1) { yield { type: 'reasoning', text: 'thinking' }; yield { type: 'done', finishReason: 'length' }; }
      else { yield { type: 'text', text: 'complete summary' }; yield { type: 'done', finishReason: 'stop' }; }
    } };
    const history: ChatMessage[] = Array.from({ length: 8 }, () => ({ role: 'user', content: 'task context '.repeat(900) }));
    const result = await new Compactor(gateway, new HookBus(), { ...options, contextWindow: 128000 }).compact(history, ref);
    expect(result).toMatchObject({ compacted: true, method: 'model' });
    expect(requests).toEqual([4096, 8192]);
  });
  it('never commits a partial length-limited summary', async () => {
    const gateway: ModelStreamer = { async *stream() { yield { type: 'text', text: 'partial' }; yield { type: 'done', finishReason: 'length' }; } };
    const history: ChatMessage[] = Array.from({ length: 8 }, () => ({ role: 'user', content: 'important context '.repeat(500) }));
    const result = await new Compactor(gateway, new HookBus(), options).compact(history, ref);
    expect(result.compacted).toBe(false); expect(result.history).toEqual(history);
    expect(result.reason).toContain('摘要输出预算耗尽');
  });
  it('falls back to shortening old tool output without changing instructions, recent work or the source history', async () => {
    const gateway: ModelStreamer = { async *stream() { throw new Error('summary offline'); } };
    const history: ChatMessage[] = [{ role: 'user', content: 'Only inspect, do not modify any file.' }];
    for (let i = 0; i < 6; i++) history.push({ role: 'assistant', content: null, toolCalls: [{ id: 'c' + i, name: 'read', arguments: '{"path":"source.ts"}' }] }, { role: 'tool', toolCallId: 'c' + i, content: 'source code '.repeat(2000) });
    history.push({ role: 'user', content: 'Keep the original constraints.' }, { role: 'assistant', content: 'Recent work stays intact.' });
    const original = structuredClone(history);
    const result = await new Compactor(gateway, new HookBus(), options).compact(history, ref);
    expect(result).toMatchObject({ compacted: true, method: 'toolOutputs', reason: 'summary offline' });
    expect(result.afterTokens!).toBeLessThan(result.beforeTokens! * .5);
    expect(history).toEqual(original);
    expect(result.history.filter(m => m.role !== 'tool')).toEqual(history.filter(m => m.role !== 'tool'));
    expect(result.history.slice(-2)).toEqual(history.slice(-2));
    expect(replayEvents([{ t: 'compacted', summary: result.summary!, history: result.history, at: '' }]).history).toEqual(result.history);
  });
  it('counts system/tool overhead and distinguishes proactive pressure from actual lack of headroom', () => {
    const gateway: ModelStreamer = { async *stream() {} };
    const compactor = new Compactor(gateway, new HookBus(), { ...options, contextWindow: 10000 });
    const history: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(32000) }];
    expect(compactor.needsCompaction(history)).toBe(true);
    expect(compactor.lacksHeadroom(history)).toBe(false);
    expect(compactor.lacksHeadroom(history, 0, 10000, 2000)).toBe(true);
  });
  it('continues compacting after more than three successful reductions', async () => {
    const gateway: ModelStreamer = { async *stream() { yield { type: 'text', text: 'summary' }; } };
    const compactor = new Compactor(gateway, new HookBus(), options);
    for (let cycle = 0; cycle < 5; cycle++) {
      const history: ChatMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'context '.repeat(600) }));
      expect(compactor.needsCompaction(history)).toBe(true);
      expect((await compactor.compact(history, ref)).compacted).toBe(true);
      expect(compactor.exhausted).toBe(false);
    }
  });
  it('bounds consecutive failures and allows an explicit new attempt after reset', async () => {
    const gateway: ModelStreamer = { async *stream() { throw new Error('offline'); } };
    const compactor = new Compactor(gateway, new HookBus(), options);
    const history: ChatMessage[] = Array.from({ length: 12 }, () => ({ role: 'user', content: 'context '.repeat(600) }));
    await compactor.compact(history, ref); await compactor.compact(history, ref);
    expect(compactor.needsCompaction(history)).toBe(false); expect(compactor.exhausted).toBe(true);
    compactor.resetConsecutive(); expect(compactor.needsCompaction(history)).toBe(true);
  });
  it('keeps all results with their shared assistant tool call', async () => {
    const gateway: ModelStreamer = { async *stream() { yield { type: 'text', text: 'summary' }; } };
    const history: ChatMessage[] = [{ role: 'user', content: 'old'.repeat(200) }, { role: 'assistant', content: 'old answer'.repeat(200) }, { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }, { id: 'b', name: 'read', arguments: '{}' }] }, { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'b', content: 'B' }, { role: 'user', content: 'continue' }];
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
