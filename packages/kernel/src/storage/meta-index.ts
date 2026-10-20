import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import type { ThreadMeta } from './thread-store.js';

export const MAX_META_BYTES = 256 * 1024;
export function validMeta(value: any, id: string): value is ThreadMeta {
  return !!value && value.id === id && typeof value.title === 'string' && typeof value.cwd === 'string' && typeof value.model === 'string' && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) && Number.isSafeInteger(value.turnCount) && value.turnCount >= 0;
}
export function fileStamp(s: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }): string {
  return [s.size, s.mtimeMs, s.ctimeMs, s.ino, s.dev].join(':');
}

/** Backward line scanning keeps memory bounded even for multi-MB image/tool
 * records. UTF-8 is decoded only after a complete, reasonably sized line. */
export function lastMeta(file: string, id: string, onRead?: (bytes: number) => void): ThreadMeta | null {
  return lastRecord(file, event => event.t === 'meta' && validMeta(event.meta, id) ? event.meta : null, onRead);
}
export function lastRecord<T>(file: string, accept: (event: any) => T | null, onRead?: (bytes: number) => void): T | null {
  const fd = openSync(file, 'r');
  try {
    let position = fstatSync(fd).size, parts: Buffer[] = [], bytes = 0, oversized = false, blockSize = 4096;
    const complete = (): T | null => {
      if (oversized || !bytes) return null;
      const line = Buffer.concat(parts.reverse(), bytes).toString('utf8').trim();
      if (!line.includes('"t"')) return null;
      try { return accept(JSON.parse(line)); } catch { return null; }
    };
    while (position > 0) {
      const size = Math.min(position, blockSize), chunk = Buffer.allocUnsafe(size); position -= size; blockSize = 65536;
      const count = readSync(fd, chunk, 0, size, position); onRead?.(count);
      let end = count;
      while (end > 0) {
        const newline = chunk.lastIndexOf(10, end - 1), segment = chunk.subarray(newline + 1, end);
        bytes += segment.length;
        if (bytes > MAX_META_BYTES) { oversized = true; parts = []; }
        else if (!oversized && segment.length) parts.push(segment);
        if (newline < 0) break;
        const found = complete(); if (found !== null) return found;
        parts = []; bytes = 0; oversized = false; end = newline;
      }
    }
    return complete();
  } finally { closeSync(fd); }
}
