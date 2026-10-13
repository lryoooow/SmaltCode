import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlThreadStore } from '../src/storage/jsonl.js';
import { replayEvents } from '../src/storage/thread-store.js';
import type { ThreadMeta } from '../src/protocol/types.js';

let dir: string;
let store: JsonlThreadStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smalt-store-'));
  store = new JsonlThreadStore(dir);
});

function meta(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id: 'th_test1',
    title: 'Test thread',
    model: 'test-model',
    cwd: '/tmp',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnCount: 0,
    ...overrides,
  };
}

describe('JsonlThreadStore', () => {
  it('appends and loads events', () => {
    store.append('th_test1', { t: 'meta', meta: meta() });
    store.append('th_test1', { t: 'user-msg', id: 'u1', text: 'hello', at: new Date().toISOString() });
    store.append('th_test1', { t: 'agent-msg', id: 'a1', text: 'hi there', at: new Date().toISOString() });

    const events = store.load('th_test1')!;
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ t: 'user-msg', text: 'hello' });
  });

  it('uses the latest meta event', () => {
    store.append('th_test1', { t: 'meta', meta: meta({ title: 'before' }) });
    store.append('th_test1', { t: 'user-msg', id: 'u1', text: 'x', at: new Date().toISOString() });
    store.append('th_test1', { t: 'meta', meta: meta({ title: 'after', turnCount: 1 }) });

    const events = store.load('th_test1')!;
    const metas = events.filter((e) => e.t === 'meta');
    expect(metas).toHaveLength(2);
    expect((metas[1] as { meta: ThreadMeta }).meta.title).toBe('after');
  });

  it('survives torn tail writes', () => {
    store.append('th_test1', { t: 'meta', meta: meta() });
    // simulate a partially-written line
    appendFileSync(join(dir, 'th_test1.jsonl'), '{"t":"user-msg","id":"u2","tex');
    const events = store.load('th_test1')!;
    expect(events).toHaveLength(1);
  });

  it('rejects unsafe ids', () => {
    expect(store.load('../../etc/passwd')).toBeNull();
    expect(store.exists('../secrets')).toBe(false);
  });

  it('lists and archives', () => {
    store.append('th_a', { t: 'meta', meta: meta({ id: 'th_a', title: 'A' }) });
    store.append('th_b', { t: 'meta', meta: meta({ id: 'th_b', title: 'B' }) });
    expect(store.listMetas().map((m) => m.id).sort()).toEqual(['th_a', 'th_b']);
    expect(store.archive('th_a')).toBe(true);
    expect(store.exists('th_a')).toBe(false);
  });
});

describe('replayEvents', () => {
  it('rebuilds the model history in order', () => {
    const { history } = replayEvents([
      { t: 'user-msg', id: 'u1', text: 'list files', at: '' },
      { t: 'agent-msg', id: 'a1', text: '', at: '' }, // placeholder replaced below
      { t: 'tool-call', id: 'c1', tool: 'shell', input: { command: 'ls' }, at: '' },
      { t: 'tool-result', id: 'c1', tool: 'shell', output: 'file1\nfile2', isError: false, at: '' },
      { t: 'agent-msg', id: 'a2', text: 'two files', at: '' },
    ]);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('applies compaction permanently', () => {
    const { history } = replayEvents([
      { t: 'user-msg', id: 'u1', text: 'old stuff', at: '' },
      { t: 'agent-msg', id: 'a1', text: 'old answer', at: '' },
      { t: 'compacted', summary: 'did old things', at: '' },
      { t: 'user-msg', id: 'u2', text: 'new stuff', at: '' },
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user' });
    expect(String(history[0]!.content)).toContain('did old things');
    expect(history[1]).toMatchObject({ role: 'user', content: 'new stuff' });
  });

  it('tracks cumulative usage', () => {
    const { lastUsage } = replayEvents([
      { t: 'usage', inputTokens: 100, outputTokens: 50, at: '' },
      { t: 'usage', inputTokens: 300, outputTokens: 80, at: '' },
    ]);
    expect(lastUsage).toEqual({ inputTokens: 300, outputTokens: 80 });
  });
});
