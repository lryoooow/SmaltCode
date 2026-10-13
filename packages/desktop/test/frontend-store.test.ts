import { describe, it, expect } from 'vitest';
import { DesktopStore, type DesktopAPI, type ThreadMeta } from '../src/renderer/src/bridge';

function fixture() {
  let notify: (method: string, params: unknown) => void = () => {};
  const metas: ThreadMeta[] = ['a', 'b'].map(id => ({ id, title: id, cwd: '/workspace', model: 'test', createdAt: '', updatedAt: '', turnCount: 0 }));
  const api = {
    onNotify: (cb: typeof notify) => { notify = cb; return () => {}; },
    onApproval: () => () => {}, onInput: () => () => {}, onResolved: () => () => {},
    call: async (method: string, params?: any) => method === 'thread/list' ? { threads: metas } : method === 'thread/read' ? { meta: metas.find(m => m.id === params.threadId), items: [], status: { threadId: params.threadId, lifecycle: 'idle', state: 'idle', queuedMessages: 0 } } : {},
    loadSettings: async () => ({ providers: {}, effective: { defaultProvider: '', defaultModel: '', permissionMode: 'default' }, keyStorage: 'encrypted' }),
  } as unknown as DesktopAPI;
  return { store: new DesktopStore(api), emit: (method: string, params: unknown) => notify(method, params) };
}
const item = { id: 'stream', kind: 'agentMessage', threadId: 'a', turnId: 'turn', createdAt: '', status: 'inProgress', text: '' };
describe('renderer session store', () => {
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
