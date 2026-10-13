import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { smaltHome } from '../config/settings.js';
import type { StoreEvent, ThreadStore, ThreadMeta } from './thread-store.js';

const safeId = /^[A-Za-z0-9_-]+$/;

export class JsonlThreadStore implements ThreadStore {
  private readonly dir: string;

  constructor(rootDir?: string) {
    this.dir = join(rootDir ?? join(smaltHome(), 'threads'));
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(threadId: string, archived = false): string {
    if (!safeId.test(threadId)) throw new Error('Invalid conversation id');
    return join(archived ? join(this.dir, 'archived') : this.dir, `${threadId}.jsonl`);
  }

  append(threadId: string, event: StoreEvent): void {
    const active = this.fileFor(threadId);
    const archived = this.fileFor(threadId, true);
    appendFileSync(!existsSync(active) && existsSync(archived) ? archived : active, `${JSON.stringify(event)}\n`, 'utf8');
  }

  load(threadId: string): StoreEvent[] | null {
    if (!safeId.test(threadId)) return null;
    const active = this.fileFor(threadId);
    const archived = !existsSync(active);
    const file = archived ? this.fileFor(threadId, true) : active;
    if (!existsSync(file)) return null;
    const events: StoreEvent[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as StoreEvent;
        if (event.t === 'meta') event.meta.archived = archived;
        events.push(event);
      } catch {
        // torn tail write — drop it
      }
    }
    return events;
  }

  listMetas(includeArchived = false): ThreadMeta[] {
    const metas: ThreadMeta[] = [];
    for (const archived of includeArchived ? [false, true] : [false]) {
    const directory = archived ? join(this.dir, 'archived') : this.dir;
    if (!existsSync(directory)) continue;
    for (const f of readdirSync(directory)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const content = readFileSync(join(directory, f), 'utf8');
        let meta: ThreadMeta | null = null;
        // scan for the last meta event without parsing everything
        for (const line of content.split('\n')) {
          if (!line.includes('"t":"meta"') && !line.includes('"t": "meta"')) continue;
          try {
            const ev = JSON.parse(line) as StoreEvent;
            if (ev.t === 'meta') meta = ev.meta;
          } catch {
            /* skip */
          }
        }
        if (meta) metas.push({ ...meta, archived });
      } catch {
        /* unreadable file — skip */
      }
    }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  exists(threadId: string): boolean {
    return safeId.test(threadId) && existsSync(this.fileFor(threadId));
  }

  /** Move a thread file out of the active list (archive). */
  archive(threadId: string): boolean {
    if (!this.exists(threadId)) return false;
    mkdirSync(join(this.dir, 'archived'), { recursive: true });
    renameSync(this.fileFor(threadId), join(this.dir, 'archived', `${threadId}.jsonl`));
    return true;
  }

  restore(threadId: string): boolean {
    if (!safeId.test(threadId) || !existsSync(this.fileFor(threadId, true))) return false;
    if (this.exists(threadId)) throw new Error('An active conversation already has this id');
    renameSync(this.fileFor(threadId, true), this.fileFor(threadId));
    return true;
  }

  delete(threadId: string): boolean {
    if (!safeId.test(threadId)) return false;
    let deleted = false;
    for (const archived of [false, true]) {
      const file = this.fileFor(threadId, archived);
      if (existsSync(file)) { unlinkSync(file); deleted = true; }
    }
    return deleted;
  }
}
