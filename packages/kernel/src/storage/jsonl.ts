import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, writeFileSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { smaltHome } from '../config/settings.js';
import type { StoreEvent, ThreadStore, ThreadMeta } from './thread-store.js';
import { lastMeta, lastRecord, fileStamp, validMeta, MAX_META_BYTES } from './meta-index.js';

const safeId = /^[A-Za-z0-9_-]+$/;

export class JsonlThreadStore implements ThreadStore {
  private readonly dir: string;
  private readonly metadata = new Map<string, { stamp: string; meta: ThreadMeta | null }>();

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
    const file = !existsSync(active) && existsSync(archived) ? archived : active;
    // Keep a torn last record from swallowing the next valid event.
    let prefix = '';
    if (existsSync(file)) { const fd = openSync(file, 'r'); try { const size = fstatSync(fd).size, byte = Buffer.alloc(1); if (size && readSync(fd, byte, 0, 1, size - 1) && byte[0] !== 10) prefix = '\n'; } finally { closeSync(fd); } }
    appendFileSync(file, `${prefix}${JSON.stringify(event)}\n`, 'utf8');
    this.metadata.delete(file);
    if (event.t === 'meta' && validMeta(event.meta, threadId)) this.readMeta(file, threadId);
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
        const id = f.slice(0, -6); if (!safeId.test(id)) continue;
        const file = join(directory, f), meta = this.readMeta(file, id);
        if (meta) metas.push({ ...meta, archived });
      } catch {
        /* unreadable file — skip */
      }
    }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private indexFile(id: string) { return join(this.dir, '.metadata', id + '.json'); }
  private readMeta(file: string, id: string): ThreadMeta | null {
    const stamp = fileStamp(statSync(file)), cached = this.metadata.get(file);
    if (cached?.stamp === stamp) return cached.meta && structuredClone(cached.meta);
    try {
      const index = this.indexFile(id);
      if (statSync(index).size <= MAX_META_BYTES) {
        const data = JSON.parse(readFileSync(index, 'utf8'));
        if (data.version === 1 && data.stamp === stamp && validMeta(data.meta, id)) { this.metadata.set(file, { stamp, meta: data.meta }); return structuredClone(data.meta); }
      }
    } catch { /* Metadata is derived; missing/stale/corrupt indices are rebuilt. */ }
    const meta = lastMeta(file, id);
    // Do not cache a result if another process appended while it was read.
    if (fileStamp(statSync(file)) === stamp) this.rememberMeta(file, id, meta, stamp);
    return meta;
  }
  private rememberMeta(file: string, id: string, meta: ThreadMeta | null, stamp: string): void {
    this.metadata.set(file, { stamp, meta: meta && structuredClone(meta) });
    if (!meta) return;
    const index = this.indexFile(id), temp = index + '.' + randomUUID() + '.tmp';
    try {
      const text = JSON.stringify({ version: 1, stamp, meta });
      if (Buffer.byteLength(text) > MAX_META_BYTES) return;
      mkdirSync(join(this.dir, '.metadata'), { recursive: true });
      writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, index);
    } catch { try { unlinkSync(temp); } catch { /* optional derived index */ } }
  }

  exists(threadId: string): boolean {
    return safeId.test(threadId) && existsSync(this.fileFor(threadId));
  }
  hasInterruptedTurn(threadId: string): boolean {
    const active = this.fileFor(threadId), file = existsSync(active) ? active : this.fileFor(threadId, true);
    if (!existsSync(file)) return false;
    const lifecycle = lastRecord(file, event => event.t === 'turn-started' || event.t === 'turn-ended' ? event.t as string : null);
    return lifecycle === 'turn-started';
  }
  latestUsage(threadId: string): { inputTokens: number; outputTokens: number } | undefined {
    const active = this.fileFor(threadId), file = existsSync(active) ? active : this.fileFor(threadId, true);
    if (!existsSync(file)) return;
    return lastRecord(file, event => event.t === 'usage' && Number.isFinite(event.inputTokens) && event.inputTokens >= 0 && Number.isFinite(event.outputTokens) && event.outputTokens >= 0 ? { inputTokens: event.inputTokens, outputTokens: event.outputTokens } : null) ?? undefined;
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
      if (existsSync(file)) { unlinkSync(file); this.metadata.delete(file); deleted = true; }
    }
    try { unlinkSync(this.indexFile(threadId)); } catch { /* optional derived index */ }
    return deleted;
  }
}
