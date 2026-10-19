import { describe, it, expect, vi, afterEach } from 'vitest';
afterEach(() => vi.useRealTimers());
import { DesktopStore, type DesktopAPI, type ThreadMeta } from '../src/renderer/src/bridge';

function fixture() {
  let notify: (method: string, params: unknown) => void = () => {};
  const completed = new Map<string, any>();
  const metas: ThreadMeta[] = ['a', 'b'].map(id => ({ id, title: id, cwd: '/workspace', model: 'test', createdAt: '', updatedAt: '', turnCount: 0 }));
  const api = {
    onNotify: (cb: typeof notify) => { notify = cb; return () => {}; },
    onApproval: () => () => {}, onInput: () => () => {}, onResolved: () => () => {},
    call: async (method: string, params?: any) => method === 'thread/list' ? { threads: metas } : method === 'thread/read' ? { meta: metas.find(m => m.id === params.threadId), items: [...completed.values()].filter(i => i.threadId === params.threadId), status: { threadId: params.threadId, lifecycle: 'idle', state: 'idle', queuedMessages: 0 } } : {},
    loadSettings: async () => ({ providers: {}, effective: { defaultProvider: '', defaultModel: '', permissionMode: 'default' }, keyStorage: 'encrypted' }),
  } as unknown as DesktopAPI;
  return { store: new DesktopStore(api), api, metas, emit: (method: string, params: any) => { if (method === 'item/completed') completed.set(params.item.id, params.item); notify(method, params); } };
}
const item = { id: 'stream', kind: 'agentMessage', threadId: 'a', turnId: 'turn', createdAt: '', status: 'inProgress', text: '' };
describe('renderer session store', () => {
  it('does not let a slower model list overwrite newer capacity metadata', async () => {
    const { store, api } = fixture();
    api.loadSettings = async () => ({ providers: { test: { baseUrl: 'https://test/v1', wire: 'chat', hasKey: false, defaultModel: 'test' } }, effective: { defaultProvider: 'test', defaultModel: 'test', permissionMode: 'default' }, keyStorage: 'session' });
    const pending = new Map<string, (value: any) => void>();
    api.listModels = async (_provider, _force, model) => new Promise(resolve => pending.set(model ?? 'all', resolve));
    await store.initialize(); const older = store.loadModels('test'), newer = store.loadModels('test', false, 'new');
    pending.get('new')!({ source: 'api', revision: 2, stale: false, models: [{ id: 'new', name: 'new', source: 'api', contextWindow: 1000000 }] }); await newer;
    pending.get('all')!({ source: 'api', revision: 1, stale: false, models: [{ id: 'old', name: 'old', source: 'api', contextWindow: 128000 }] }); await older;
    expect(store.getSnapshot().settings?.catalogs?.test.models[0]?.contextWindow).toBe(1000000); store.dispose();
  });
  it('restores the precise terminal failure and never lets a stale read overwrite a newly running turn', async () => {
    const { store, api, metas, emit } = fixture();
    metas[0].lastOutcome = 'failed'; metas[0].lastError = 'Actual summary failure: HTTP 503';
    await store.initialize(); await store.open('a'); expect(store.getSnapshot().sessions.a.error).toBe(metas[0].lastError);
    const call = api.call.bind(api); let complete!: (value: any) => void;
    api.call = ((method: string, params: any) => method === 'thread/read' ? new Promise(resolve => { complete = resolve; }) : call(method, params)) as any;
    const opening = store.open('a');
    emit('turn/started', { threadId: 'a', turnId: 'new-turn' });
    const notice = { turnId: 'new-turn', level: 'warning', message: 'Task continues.', reason: 'precise reason' };
    emit('thread/context/notice', { threadId: 'a', notice });
    complete({ meta: { ...metas[0] }, items: [], status: { lifecycle: 'idle' } }); await opening;
    expect(store.getSnapshot().sessions.a.error).toBeUndefined();
    expect(store.getSnapshot().sessions.a.contextNotice).toEqual(notice);
    const activeOpen = store.open('a');
    complete({ meta: { ...metas[0] }, items: [], status: { lifecycle: 'running' } }); await activeOpen;
    expect(store.getSnapshot().sessions.a.error).toBeUndefined();
    store.dispose();
  });
  it('batches a thousand deltas while preserving the final text and ordering', async () => {
    vi.useFakeTimers(); const { store, emit } = fixture(); await store.initialize(); emit('item/started', { item });
    let updates = 0; const off = store.subscribe(() => updates++);
    for (let i = 0; i < 1000; i++) emit('item/agentMessage/delta', { threadId: 'a', itemId: 'stream', delta: 'x' });
    expect(updates).toBe(0); await vi.advanceTimersByTimeAsync(51); expect(updates).toBe(1);
    expect(store.getSnapshot().sessions.a.items[0]).toMatchObject({ text: 'x'.repeat(1000) });
    off(); store.dispose();
  });
  it('bounds burst command output while browsing another conversation and retains the final diagnostic', async () => {
    vi.useFakeTimers(); const { store, emit } = fixture(); await store.initialize();
    const command = { id: 'cmd', kind: 'commandExecution', threadId: 'a', turnId: 'turn', createdAt: '', status: 'inProgress', tool: 'shell', command: 'pnpm test & echo EXIT_CODE=0', output: '', exitCode: null };
    emit('item/started', { item: command }); await store.open('b');
    for (let i = 0; i < 1000; i++) emit('item/commandExecution/outputDelta', { threadId: 'a', itemId: 'cmd', delta: 'x'.repeat(2000) });
    await vi.advanceTimersByTimeAsync(51);
    const streamed = store.getSnapshot().sessions.a.items[0];
    expect(streamed.kind === 'commandExecution' && streamed.output.length).toBeLessThanOrEqual(30000);
    expect(store.getSnapshot().sessions.b.items).toHaveLength(0);
    emit('item/completed', { item: { ...command, status: 'completed', exitCode: 0, output: '[exit 0]\n1 failed\nEXIT_CODE=0' } });
    emit('turn/completed', { threadId: 'a', turnId: 'turn' }); await store.open('a');
    expect(store.getSnapshot().sessions.a.items[0]).toMatchObject({ output: expect.stringContaining('1 failed'), assessment: { kind: 'unverified', code: 'exitCodeConflict' } });
    store.dispose();
  });
  it('removes failed-connection subscriptions before reconnecting', async () => {
    vi.useFakeTimers(); const callbacks = new Set<(method: string, params: any) => void>(); let attempts = 0;
    const api = { onNotify: (callback: any) => { callbacks.add(callback); return () => callbacks.delete(callback); }, onApproval: () => () => {}, onInput: () => () => {}, onResolved: () => () => {},
      call: async (method: string) => { if (method === 'initialize' && attempts++ === 0) throw Error('fixture offline'); return method === 'thread/list' ? { threads: [{ id: 'a', title: 'a', cwd: '/workspace', model: 'test', createdAt: '', updatedAt: '', turnCount: 0 }] } : { projects: [] }; }, loadSettings: async () => ({ providers: {}, effective: {} }) } as unknown as DesktopAPI;
    const store = new DesktopStore(api); await store.initialize(); expect(callbacks.size).toBe(0); await store.initialize(); expect(callbacks.size).toBe(1);
    for (const callback of callbacks) { callback('item/started', { item }); callback('item/agentMessage/delta', { threadId: 'a', itemId: 'stream', delta: 'one' }); }
    await vi.advanceTimersByTimeAsync(51); expect(store.getSnapshot().sessions.a.items[0]).toMatchObject({ text: 'one' }); store.dispose(); expect(callbacks.size).toBe(0);
  });
  it('keeps streamed content while switching to another task and deduplicates completion', async () => {
    const { store, emit } = fixture(); await store.initialize(); await store.open('a');
    emit('item/started', { item }); emit('item/agentMessage/delta', { threadId: 'a', itemId: 'stream', delta: 'first ' });
    await store.open('b'); emit('item/agentMessage/delta', { threadId: 'a', itemId: 'stream', delta: 'second' });
    emit('item/completed', { item: { ...item, status: 'completed', text: 'first second' } });
    emit('turn/completed', { threadId: 'a', turnId: 'turn' }); await store.open('a');
    expect(store.getSnapshot().sessions.a.items).toHaveLength(1);
    expect(store.getSnapshot().sessions.a.items[0]).toMatchObject({ text: 'first second', status: 'completed' });
    expect(store.getSnapshot().sessions.a.unread).toBe(false);
  });
  it('shows interrupted streams as incomplete instead of successful replies', async () => {
    const { store, emit } = fixture(); await store.initialize();
    emit('item/started', { item }); emit('item/agentMessage/delta', { threadId: 'a', itemId: 'stream', delta: 'partial' });
    emit('turn/completed', { threadId: 'a', turnId: 'turn', interrupted: true });
    expect(store.getSnapshot().sessions.a).toMatchObject({ interrupted: true, items: [{ text: 'partial', status: 'failed' }] });
  });
});
