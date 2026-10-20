import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/core/kernel.js';
import { JsonlThreadStore } from '../src/storage/jsonl.js';
import { replayEvents } from '../src/storage/thread-store.js';
import { estimateHistoryTokens } from '../src/models/types.js';
import { ContextPipeline, envInterceptor } from '../src/context/pipeline.js';
import { toChatWireMessages } from '../src/models/adapters/chat.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'smalt-recovery-')); vi.stubEnv('SMALT_HOME', dir); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
describe('unfinished task recovery', () => {
  it('persists a recoverable state, repairs unfinished tool pairs, and never executes them', async () => {
    const store = new JsonlThreadStore(join(dir, 'threads'));
    const kernel = new Kernel({ cwd: dir, store, client: { notify: vi.fn(), requestApproval: vi.fn(), askUser: vi.fn() } });
    const result = await kernel.handle('thread/start', { cwd: dir, title: '异常中断任务' }) as { threadId: string };
    store.append(result.threadId, { t: 'turn-started', turnId: 'unfinished', at: '2026-10-15T01:00:00Z' });
    store.append(result.threadId, { t: 'user-msg', id: 'u1', text: '修复资料', at: '2026-10-15T01:00:01Z' });
    store.append(result.threadId, { t: 'tool-call', id: 'pending-write', tool: 'write', input: { path: 'result.txt', content: 'never replay' }, at: '2026-10-15T01:00:02Z' });
    kernel.threads.recoverInterrupted();
    const events = store.load(result.threadId)!;
    const metadata = store.listMetas()[0]!;
    expect(metadata).toMatchObject({ lastOutcome: 'interrupted', recovery: { turnId: 'unfinished' } });
    expect(events.find(event => event.t === 'tool-result')).toMatchObject({ isError: true, output: expect.stringContaining('避免重复操作') });
    const count = events.length; kernel.threads.recoverInterrupted(); expect(store.load(result.threadId)).toHaveLength(count);
    const history = replayEvents(events).history;
    expect(history.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'pending-write', isError: true });
    await expect(import('node:fs/promises').then(fs => fs.stat(join(dir, 'result.txt')))).rejects.toThrow();
  });
  it('leaves fully ended tasks and their outcome untouched', async () => {
    const store = new JsonlThreadStore(join(dir, 'threads')), kernel = new Kernel({ cwd: dir, store, client: { notify: vi.fn(), requestApproval: vi.fn(), askUser: vi.fn() } });
    const result = await kernel.handle('thread/start', { cwd: dir }) as { threadId: string };
    store.append(result.threadId, { t: 'turn-started', turnId: 'done', at: '2026-10-15T01:00:00Z' });
    store.append(result.threadId, { t: 'turn-ended', turnId: 'done', at: '2026-10-15T01:01:00Z' });
    const count = store.load(result.threadId)!.length, load = vi.spyOn(store, 'load');
    kernel.threads.recoverInterrupted(); expect(load).not.toHaveBeenCalled(); expect(store.load(result.threadId)).toHaveLength(count);
  });
});
describe('image input survives replay and context assembly', () => {
  it('preserves actual image parts instead of expanding base64 into text tokens', async () => {
    const image = { type: 'image' as const, mimeType: 'image/png', dataBase64: 'a'.repeat(10000) };
    const history = replayEvents([{ t: 'user-msg', id: 'u', text: '查看截图', images: [image], at: '2026-10-15T01:00:00Z' }]).history;
    expect(estimateHistoryTokens(history)).toBeLessThan(1100);
    const prompt = await new ContextPipeline([envInterceptor(() => new Date('2026-10-15T00:00:00Z'))]).assemble({ threadId: 't', turnId: 'r', cwd: dir, modelRef: { provider: 'p', model: 'm' }, history, prompt: [...history], input: '查看截图', toolNames: [], systemExtras: [] });
    const wire = toChatWireMessages(prompt) as any[];
    expect(wire.find(message => message.role === 'user').content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.dataBase64 } });
    expect(wire.find(message => message.role === 'system').content).toContain('2026-10-15');
  });
  it('rejects too many images and unsupported image MIME before contacting a model', async () => {
    const kernel = new Kernel({ cwd: dir, client: { notify: vi.fn(), requestApproval: vi.fn(), askUser: vi.fn() } });
    const result = await kernel.handle('thread/start', { cwd: dir }) as { threadId: string };
    await expect(kernel.handle('turn/start', { threadId: result.threadId, input: 'test', images: [{ type: 'image', mimeType: 'image/svg+xml', dataBase64: 'abcd' }] })).rejects.toThrow('图片');
    await expect(kernel.handle('turn/start', { threadId: result.threadId, input: 'test', images: Array(5).fill({ type: 'image', mimeType: 'image/png', dataBase64: 'abcd' }) })).rejects.toThrow('4 张');
    expect(kernel.threads.status(result.threadId).lifecycle).toBe('idle');
  });
});
