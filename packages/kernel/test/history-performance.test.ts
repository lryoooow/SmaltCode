import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { JsonlThreadStore } from '../src/storage/jsonl.js';
import { lastMeta } from '../src/storage/meta-index.js';
vi.mock('node:fs', async original => { const real = await original<typeof import('node:fs')>(); return { ...real, readFileSync: vi.fn(real.readFileSync), readSync: vi.fn(real.readSync) }; });
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'smalt-history-')); });
afterEach(() => { if (dirname(dir) !== tmpdir() || !dir.includes('smalt-history-')) throw new Error('Unsafe fixture'); fs.rmSync(dir, { recursive: true, force: true }); });
const meta = (id = 'th_test', title = '中文对话') => ({ id, title, cwd: '/fixture', model: 'fixture', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', turnCount: 1 });
it('finds the latest valid metadata with bounded tail I/O, skipping malformed final rows', () => {
  const file = join(dir, 'th_test.jsonl');
  fs.writeFileSync(file, JSON.stringify({ t: 'meta', meta: meta() }) + '\n' + 'x'.repeat(8 * 1024 * 1024) + '\n' + JSON.stringify({ t: 'meta', meta: meta('th_test', '最后状态') }) + '\n' + '{broken');
  let bytes = 0; expect(lastMeta(file, 'th_test', n => bytes += n)?.title).toBe('最后状态'); expect(bytes).toBeLessThanOrEqual(65536);
});
it('can recover a leading meta across huge UTF-8 and image-sized lines without accepting fake metadata inside content', () => {
  const file = join(dir, 'th_test.jsonl');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ t: 'meta', meta: meta() }) + '\n' + JSON.stringify({ t: 'agent-msg', text: '中文'.repeat(200000) + JSON.stringify({ t: 'meta', meta: meta('th_test', '假的') }) }) + '\n');
  expect(lastMeta(file, 'th_test')?.title).toBe('中文对话');
});
it('uses disk indices on a cold start and memory cache on repeat listing instead of reading 50 MB of history', () => {
  const store = new JsonlThreadStore(dir), text = 'x'.repeat(256 * 1024);
  for (let i = 0; i < 200; i++) { const id = 'th_' + i; store.append(id, { t: 'agent-msg', id: 'a', text, at: '' }); store.append(id, { t: 'meta', meta: meta(id) }); }
  vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  const cold = new JsonlThreadStore(dir); expect(cold.listMetas()).toHaveLength(200);
  expect(vi.mocked(fs.readFileSync).mock.calls.every(([path]) => String(path).includes('.metadata'))).toBe(true); expect(fs.readSync).not.toHaveBeenCalled();
  vi.mocked(fs.readFileSync).mockClear(); expect(cold.listMetas()).toHaveLength(200); expect(fs.readFileSync).not.toHaveBeenCalled();
});
it('invalidates stale indices after external writes and safely rebuilds corrupted indices', () => {
  const store = new JsonlThreadStore(dir); store.append('th_test', { t: 'meta', meta: meta() }); expect(store.listMetas()[0].title).toBe('中文对话');
  fs.appendFileSync(join(dir, 'th_test.jsonl'), JSON.stringify({ t: 'meta', meta: meta('th_test', '外部更新') }) + '\n');
  expect(store.listMetas()[0].title).toBe('外部更新'); fs.writeFileSync(join(dir, '.metadata/th_test.json'), '{broken');
  expect(new JsonlThreadStore(dir).listMetas()[0].title).toBe('外部更新');
  const result = store.listMetas(); result[0].title = '调用者修改'; expect(store.listMetas()[0].title).toBe('外部更新');
});
it('retains archive/restore/delete semantics and safely appends after a torn last line', () => {
  const store = new JsonlThreadStore(dir); store.append('th_test', { t: 'meta', meta: meta() }); fs.appendFileSync(join(dir, 'th_test.jsonl'), '{torn');
  store.append('th_test', { t: 'meta', meta: meta('th_test', '恢复后') }); expect(store.load('th_test')?.filter(e => e.t === 'meta')).toHaveLength(2);
  store.archive('th_test'); expect(store.listMetas()).toEqual([]); expect(store.listMetas(true)[0]).toMatchObject({ archived: true, title: '恢复后' });
  store.restore('th_test'); expect(store.listMetas()[0].archived).toBe(false); store.delete('th_test'); expect(store.listMetas(true)).toEqual([]);
});
it('checks completed-turn lifecycle from the tail without replaying an entire history and still finds interrupted work', () => {
  const store = new JsonlThreadStore(dir); store.append('th_test', { t: 'meta', meta: meta() });
  store.append('th_test', { t: 'turn-started', turnId: 'turn-1', at: '' });
  store.append('th_test', { t: 'agent-msg', id: 'a', text: 'x'.repeat(2 * 1024 * 1024), at: '' });
  expect(store.hasInterruptedTurn('th_test')).toBe(true);
  store.append('th_test', { t: 'turn-ended', turnId: 'turn-1', at: '' });
  vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  expect(store.hasInterruptedTurn('th_test')).toBe(false); expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(vi.mocked(fs.readSync).mock.calls.reduce((sum, call) => sum + (call[3] as number), 0)).toBeLessThanOrEqual(4096);
});
it('reads legacy usage from the tail, skips malformed counters and supports archived history', () => {
  const store = new JsonlThreadStore(dir); store.append('th_test', { t: 'meta', meta: meta() });
  store.append('th_test', { t: 'agent-msg', id: 'a', text: 'x'.repeat(2 * 1024 * 1024), at: '' });
  store.append('th_test', { t: 'usage', inputTokens: 1234, outputTokens: 567, at: '' });
  fs.appendFileSync(join(dir, 'th_test.jsonl'), '{"t":"usage","inputTokens":-1,"outputTokens":0}\n');
  vi.mocked(fs.readFileSync).mockClear(); vi.mocked(fs.readSync).mockClear();
  expect(store.latestUsage('th_test')).toEqual({ inputTokens: 1234, outputTokens: 567 }); expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(vi.mocked(fs.readSync).mock.calls.reduce((sum, call) => sum + (call[3] as number), 0)).toBeLessThanOrEqual(4096);
  store.archive('th_test'); expect(store.latestUsage('th_test')).toEqual({ inputTokens: 1234, outputTokens: 567 });
});
