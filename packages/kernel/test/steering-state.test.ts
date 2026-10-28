import { describe, it, expect } from 'vitest';
import { SteeringState } from '../src/core/steering-state.js';

describe('acknowledged steering queue', () => {
  it('uses stable IDs and revisions; edits preserve captured references/images and private context', () => {
    const queue = new SteeringState();
    const entry = queue.accept({ text: '原说明\nPRIVATE_CONTEXT', displayText: '原说明', references: [{ path: 'a.md' }], images: [{ type: 'image', mimeType: 'image/png', dataBase64: 'fixture' }] });
    expect(entry).toMatchObject({ revision: 1, state: 'pending', text: '原说明', imageCount: 1 });
    const updated = queue.change(entry.id, 1, '改后说明');
    expect(queue.pending[0]).toMatchObject({ text: '改后说明\nPRIVATE_CONTEXT', displayText: '改后说明', images: [{ dataBase64: 'fixture' }] });
    expect(updated).toMatchObject({ id: entry.id, revision: 2, references: [{ path: 'a.md' }] });
    expect(JSON.stringify(queue.snapshot())).not.toContain('PRIVATE_CONTEXT');
    expect(() => queue.change(entry.id, 1)).toThrow('已更新');
  });
  it('consumption wins races; applied input cannot be edited or falsely withdrawn', () => {
    const queue = new SteeringState(), entry = queue.accept('use this');
    const prompt = queue.pending.shift()!; queue.applied(prompt, 'turn1');
    expect(queue.snapshot()[0]).toMatchObject({ state: 'applied', revision: 2, turnId: 'turn1' });
    expect(() => queue.change(entry.id, 1, 'too late')).toThrow('已被采用');
    expect(() => queue.change(entry.id, 2)).toThrow('已被采用');
    queue.finish(); expect(queue.snapshot()[0]!.state).toBe('applied');
  });
  it('withdraws only pending inputs and marks unconsumed input unused on stop/finish', () => {
    const queue = new SteeringState(), first = queue.accept('withdraw'), second = queue.accept('unused');
    queue.change(first.id, 1); expect(queue.pending).toHaveLength(1);
    queue.finish(); expect(queue.pending).toHaveLength(0);
    expect(queue.snapshot().map(entry => entry.state)).toEqual(['cancelled', 'unused']);
    expect(() => queue.change(second.id, 2)).toThrow('不能再修改');
  });
  it('recovers persisted receipts without replay; closes the crash gap using actual user-message evidence', () => {
    const original = new SteeringState(); const used = original.accept('used'), unused = original.accept('unused');
    const restored = new SteeringState(); restored.restore(original.snapshot(), new Map([[used.id, 'turn1']]));
    expect(restored.pending).toHaveLength(0);
    expect(restored.snapshot()).toMatchObject([{ id: used.id, state: 'applied' }, { id: unused.id, state: 'unused' }]);
  });
  it('bounds pending and retained records; rejects empty input and unsafe context separation', () => {
    const queue = new SteeringState();
    expect(() => queue.accept(' ')).toThrow('不能为空');
    expect(() => queue.accept('a'.repeat(20001))).toThrow('20000');
    const opaque = queue.accept({ text: 'private', displayText: 'display' });
    expect(() => queue.change(opaque.id, 1, 'new')).toThrow('不能安全分离');
    queue.change(opaque.id, 1);
    for (let i = 0; i < 20; i++) queue.accept('pending' + i);
    expect(() => queue.accept('overflow')).toThrow('20');
    queue.finish();
    for (let i = 0; i < 120; i++) { const entry = queue.accept('receipt' + i); queue.change(entry.id, 1); }
    expect(queue.snapshot()).toHaveLength(100);
  });
  it('isolates corrupt persisted receipts without replaying them or breaking the valid record', () => {
    const source = new SteeringState(), valid = source.accept('valid');
    const restored = new SteeringState();
    restored.restore([null, { ...valid, id: 'bad-time', createdAt: null }, { ...valid, id: 'bad-refs', references: [{}] }, valid] as any, new Map());
    expect(restored.pending).toHaveLength(0);
    expect(restored.snapshot()).toMatchObject([{ id: valid.id, state: 'unused' }]);
  });

});
