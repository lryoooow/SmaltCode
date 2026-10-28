import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LocalSpace = { cwd: string; kind: 'managed' };
/** Host-owned leaf scopes; neither the storage root nor a sibling is granted. */
export class LocalSpaces {
  readonly root: string;
  private readonly registry: string;
  private readonly ids = new Set<string>();
  private readonly claims: Record<string, string> = {};
  private readonly busy = new Set<string>();
  readonly notice?: string;
  constructor(home: string) {
    this.root = resolve(dirname(home), 'Files'); this.registry = join(home, 'local-spaces.json');
    if (existsSync(this.registry)) {
      try {
        const value = JSON.parse(readFileSync(this.registry, 'utf8'));
        if (value?.root !== this.root || !Array.isArray(value.ids) || value.ids.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('invalid local space registry');
        value.ids.forEach((id: string) => this.ids.add(id));
        if (value.claims && typeof value.claims === 'object') for (const [id, owner] of Object.entries(value.claims)) if (this.ids.has(id) && typeof owner === 'string') this.claims[id] = owner;
      } catch { renameSync(this.registry, this.registry + '.corrupt-' + randomUUID()); this.notice = '本地空间索引损坏，原记录已保留；新对话使用新的独立空间，已有历史不删除。'; }
    }
  }
  create(): LocalSpace {
    mkdirSync(this.root, { recursive: true });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('本地空间根目录不能是目录链接');
    const id = randomUUID(), cwd = join(this.root, id); mkdirSync(cwd, { mode: 0o700 });
    const updated = [...this.ids, id], temporary = this.registry + '.' + randomUUID() + '.tmp';
    mkdirSync(dirname(this.registry), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ root: this.root, ids: updated, claims: this.claims }), { mode: 0o600 }); renameSync(temporary, this.registry);
    this.ids.add(id); return { cwd: realpathSync(cwd), kind: 'managed' };
  }
  owns(cwd: string): boolean {
    try {
      const child = relative(this.root, resolve(cwd));
      if (isAbsolute(child) || !this.ids.has(child) || lstatSync(this.root).isSymbolicLink() || lstatSync(cwd).isSymbolicLink()) return false;
      const canonical = realpathSync(cwd), expected = join(realpathSync(this.root), child);
      return process.platform === 'win32' ? canonical.toLowerCase() === expected.toLowerCase() : canonical === expected;
    } catch { return false; }
  }
  contains(cwd: string): boolean { const child = relative(this.root, resolve(cwd)); return !child || !child.startsWith('..') && !isAbsolute(child); }
  reserve(cwd: string): void {
    const id = relative(this.root, resolve(cwd));
    if (!this.owns(cwd) || this.claims[id] || this.busy.has(id)) throw new Error('此本地空间已属于另一段对话，请新建独立空间');
    this.busy.add(id);
  }
  available(cwd: string): boolean { const id = relative(this.root, resolve(cwd)); return this.owns(cwd) && !this.claims[id] && !this.busy.has(id); }
  forThread(threadId:string):string|undefined { const matches=Object.entries(this.claims).filter(([,owner])=>owner===threadId).map(([id])=>join(this.root,id)).filter(path=>this.owns(path)); if(matches.length>1)throw Error('同一对话的本地空间归属冲突，请检查索引；未选择其他目录'); return matches[0]; }
  finish(cwd: string, threadId?: string): void {
    const id = relative(this.root, resolve(cwd)); this.busy.delete(id);
    if (threadId) {
      const claims = { ...this.claims, [id]: threadId }, temporary = this.registry + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify({ root: this.root, ids: [...this.ids], claims }), { mode: 0o600 }); renameSync(temporary, this.registry);
      this.claims[id] = threadId;
    }
  }
}
