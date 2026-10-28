import type { SteeringEntry, UserPrompt } from '../protocol/types.js';
import { newId, nowIso } from '../util.js';

/** Mutation and consumption are synchronous: a revision cannot be withdrawn after use. */
export class SteeringState {
  readonly pending: UserPrompt[] = [];
  private records = new Map<string, SteeringEntry>();
  onChange?: (entry: SteeringEntry) => void;
  snapshot(): SteeringEntry[] { return [...this.records.values()].map(entry => ({ ...entry, references: entry.references?.map(ref => ({ ...ref })) })); }
  private save(entry: SteeringEntry): SteeringEntry {
    this.records.set(entry.id, entry);
    while (this.records.size > 100) {
      const oldest = [...this.records.values()].find(value => value.state !== 'pending');
      if (!oldest) break;
      this.records.delete(oldest.id);
    }
    this.onChange?.({ ...entry });
    return entry;
  }
  accept(prompt: UserPrompt): SteeringEntry {
    const value = typeof prompt === 'string' ? { text: prompt } : prompt;
    const text = value.displayText ?? value.text;
    if (!text.trim() || text.length > 20_000 || value.text.length > 120_000) throw new Error('补充说明不能为空，正文最多 20000 字符，连同引用最多 120000 字符');
    if (this.pending.length >= 20) throw new Error('最多暂存 20 条补充说明，请等待处理或撤回部分内容');
    const id = newId('steer'), at = nowIso();
    this.pending.push({ ...value, steeringId: id });
    return this.save({ id, revision: 1, text, references: value.references, imageCount: value.images?.length ?? 0, state: 'pending', createdAt: at, updatedAt: at, editable: value.text.startsWith(text) });
  }
  change(id: string, revision: number, text?: string): SteeringEntry {
    const entry = this.records.get(id);
    if (!entry || entry.state !== 'pending') throw new Error('这条说明已被采用、撤回或结束，不能再修改；请补充新的说明');
    if (!Number.isInteger(revision) || revision !== entry.revision) throw new Error('说明已更新，请核对最新内容后再操作');
    const index = this.pending.findIndex(prompt => typeof prompt !== 'string' && prompt.steeringId === id);
    if (index < 0) throw new Error('说明正在被采用，请核对最新状态');
    if (text !== undefined) {
      if (!entry.editable) throw new Error('这条说明的上下文不能安全分离，请撤回后重新发送');
      if (!text.trim() || text.length > 20_000) throw new Error('补充说明不能为空，最多 20000 字符');
      const prompt = this.pending[index] as Exclude<UserPrompt, string>;
      this.pending[index] = { ...prompt, text: text + prompt.text.slice(entry.text.length), displayText: text };
    } else this.pending.splice(index, 1);
    return this.save({ ...entry, text: text ?? entry.text, state: text === undefined ? 'cancelled' : 'pending', revision: entry.revision + 1, updatedAt: nowIso() });
  }
  applied(prompt: UserPrompt, turnId: string): void {
    const id = typeof prompt === 'string' ? undefined : prompt.steeringId;
    const entry = id ? this.records.get(id) : undefined;
    if (entry?.state === 'pending') this.save({ ...entry, state: 'applied', turnId, revision: entry.revision + 1, updatedAt: nowIso() });
  }
  finish(): void {
    this.pending.length = 0;
    for (const entry of this.records.values()) if (entry.state === 'pending') this.save({ ...entry, state: 'unused', revision: entry.revision + 1, updatedAt: nowIso() });
  }
  restore(entries: SteeringEntry[], applied: Map<string, string>): void {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || entry.id.length > 256 || typeof entry.text !== 'string' || entry.text.length > 20_000 || !Number.isInteger(entry.revision) || entry.revision < 1 || !['pending', 'applied', 'cancelled', 'unused'].includes(entry.state) || typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string' || typeof entry.editable !== 'boolean' || !Number.isInteger(entry.imageCount) || entry.imageCount < 0 || entry.imageCount > 4 || entry.references !== undefined && (!Array.isArray(entry.references) || entry.references.length > 10 || entry.references.some(ref => !ref || typeof ref.path !== 'string' || ref.label !== undefined && typeof ref.label !== 'string'))) continue;
      this.records.set(entry.id, entry);
    }
    for (const entry of this.records.values()) {
      if (entry.state !== 'pending') continue;
      const turnId = applied.get(entry.id);
      this.save({ ...entry, state: turnId ? 'applied' : 'unused', turnId, revision: entry.revision + 1, updatedAt: nowIso() });
    }
    // Bound reloaded history as well as live records, without replaying any input.
    const recent = [...this.records.values()].slice(-100);
    this.records = new Map(recent.map(entry => [entry.id, entry]));
  }
}
