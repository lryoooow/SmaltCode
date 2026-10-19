/**
 * Patch applier: locates hunks by context (never by line number) and rewrites
 * files. Matching is exact first, then whitespace-insensitive — mirroring the
 * "seek sequence" idea from codex so minor drift doesn't break a patch.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { unifiedDiff } from '../../../util.js';
import { parsePatch, type PatchFile, type PatchLine } from './parser.js';

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface AppliedChange {
  path: string;
  action: 'add' | 'update' | 'delete' | 'move';
  diff?: string;
  /** number of hunks applied (updates only) */
  hunks?: number;
}

export interface ApplyReport {
  changes: AppliedChange[];
  summary: string;
}

export function applyPatch(patchText: string, cwd: string): ApplyReport {
  const files = parsePatch(patchText);
  const changes: AppliedChange[] = [];
  const original = new Map<string, Buffer | null>();
  const staged = new Map<string, string | null>();
  const dirty = new Set<string>();
  const physical = new Map<string, string>();
  const keyOf = (path: string) => { const key = process.platform === 'win32' ? path.toLowerCase() : path; if (!physical.has(key)) physical.set(key, path); return key; };
  const get = (path: string): string | null => {
    const key = keyOf(path);
    if (!staged.has(key)) {
      const bytes = existsSync(path) ? readFileSync(path) : null;
      original.set(key, bytes); staged.set(key, bytes?.toString('utf8') ?? null);
    }
    return staged.get(key)!;
  };
  const filesystem: PatchFilesystem = {
    exists: path => get(path) !== null,
    read: path => { const value = get(path); if (value === null) throw new ApplyError(`Missing file: ${path}`); return value; },
    write: (path, text) => { get(path); const key = keyOf(path); staged.set(key, text); dirty.add(key); },
    remove: path => { get(path); const key = keyOf(path); staged.set(key, null); dirty.add(key); },
    move: (from, to) => { if (get(to) !== null) throw new ApplyError(`Move destination already exists: ${to}`); const value = get(from); const source = keyOf(from), target = keyOf(to); staged.set(target, value); staged.set(source, null); dirty.add(source); dirty.add(target); },
  };
  // Validate and compute every change in memory before touching any file.
  for (const file of files) changes.push(applyOne(file, cwd, filesystem));
  try {
    for (const key of dirty) {
      const path = physical.get(key)!;
      const text = staged.get(key)!;
      if (text === null) { if (existsSync(path)) rmSync(path); }
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); }
    }
  } catch (error) {
    for (const key of dirty) {
      const path = physical.get(key)!;
      const bytes = original.get(key);
      if (bytes === null) { if (existsSync(path)) rmSync(path); }
      else if (bytes) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
    }
    throw error;
  }
  const summary = changes
    .map((c) => `${c.action} ${c.path}${c.hunks ? ` (${c.hunks} hunk${c.hunks > 1 ? 's' : ''})` : ''}`)
    .join(', ');
  return { changes, summary: `applied: ${summary}` };
}

interface PatchFilesystem { exists(path: string): boolean; read(path: string): string; write(path: string, text: string): void; remove(path: string): void; move(from: string, to: string): void }
function linesOf(text: string): string[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return clean ? (clean.endsWith('\n') ? clean.slice(0, -1) : clean).split('\n') : [];
}
function applyOne(file: PatchFile, cwd: string, fs: PatchFilesystem): AppliedChange {
  const abs = toAbs(file.path, cwd);

  switch (file.kind) {
    case 'add': {
      if (fs.exists(abs)) {
        throw new ApplyError(`Add File target already exists: ${file.path}`);
      }
      fs.write(abs, file.lines.join('\n') + (file.lines.length ? '\n' : ''));
      return {
        path: file.path,
        action: 'add',
        diff: ['--- /dev/null', `+++ b/${file.path}`, '@@ -0,0 +1,N @@', ...file.lines.map((l) => `+${l}`)].join('\n'),
      };
    }

    case 'delete': {
      if (!fs.exists(abs)) {
        throw new ApplyError(`Delete File target does not exist: ${file.path}`);
      }
      const before = fs.read(abs);
      fs.remove(abs);
      return {
        path: file.path,
        action: 'delete',
        diff: unifiedDiff(file.path, linesOf(before), []),
      };
    }

    case 'update': {
      if (!fs.exists(abs)) {
        throw new ApplyError(`Update File target does not exist: ${file.path}`);
      }
      const before = fs.read(abs);
      const beforeLines = linesOf(before);
      let cursor = 0;
      let applied = 0;

      for (const hunk of file.hunks) {
        const { matchedAt, consumed, replaced } = applyHunkAt(beforeLines, hunk.lines, cursor, hunk.endOfFile);
        if (matchedAt < 0) {
          const expected = hunk.lines
            .filter((l) => l.kind !== 'add')
            .map((l) => l.text)
            .slice(0, 3)
            .join(' | ');
          throw new ApplyError(
            `could not locate hunk in ${file.path}${hunk.anchor ? ` (@@ ${hunk.anchor})` : ''} — expected near: ${expected}`,
          );
        }
        beforeLines.splice(matchedAt, consumed, ...replaced);
        cursor = matchedAt + replaced.length;
        applied++;
      }

      const target = file.moveTo ? toAbs(file.moveTo, cwd) : abs;
      const newline = before.includes('\r\n') ? '\r\n' : '\n';
      const newText = (before.startsWith('\uFEFF') ? '\uFEFF' : '') + beforeLines.join(newline) + (before.endsWith('\n') && beforeLines.length ? newline : '');
      if (file.moveTo) {
        fs.move(abs, target);
        fs.write(target, newText);
        return {
          path: `${file.path} → ${file.moveTo}`,
          action: 'move',
          diff: unifiedDiff(file.path, readOldForDiff(abs, before), beforeLines),
          hunks: applied,
        };
      }
      fs.write(abs, newText);
      return {
        path: file.path,
        action: 'update',
        diff: unifiedDiff(file.path, linesOf(before), beforeLines),
        hunks: applied,
      };
    }
  }
}

function readOldForDiff(_abs: string, before: string): string[] {
  return linesOf(before);
}

function toAbs(p: string, cwd: string): string {
  return resolve(cwd, p);
}

/**
 * Find where the hunk's expected (non-add) lines occur in `lines` at or after
 * `from`, then build the replacement. Returns matchedAt = -1 on failure.
 */
function applyHunkAt(
  lines: string[],
  hunkLines: PatchLine[],
  from: number,
  endOfFile = false,
): { matchedAt: number; consumed: number; replaced: string[] } {
  const expected = hunkLines.filter((l) => l.kind !== 'add').map((l) => l.text);
  if (!expected.length) {
    // pure insertion with no context — insert at cursor
    return { matchedAt: endOfFile ? lines.length : from, consumed: 0, replaced: hunkLines.map((l) => l.text) };
  }

  for (let pos = endOfFile ? Math.max(from, lines.length - expected.length) : from; pos <= lines.length - expected.length; pos++) {
    if (seqMatches(lines, pos, expected, false)) {
      return { matchedAt: pos, consumed: expected.length, replaced: buildReplacement(hunkLines, lines, pos, false) };
    }
  }
  // fuzzy pass: ignore leading/trailing whitespace differences
  for (let pos = endOfFile ? Math.max(from, lines.length - expected.length) : from; pos <= lines.length - expected.length; pos++) {
    if (seqMatches(lines, pos, expected, true)) {
      return { matchedAt: pos, consumed: expected.length, replaced: buildReplacement(hunkLines, lines, pos, true) };
    }
  }
  return { matchedAt: -1, consumed: 0, replaced: [] };
}

function seqMatches(lines: string[], pos: number, expected: string[], fuzzy: boolean): boolean {
  for (let k = 0; k < expected.length; k++) {
    const actual = lines[pos + k] ?? '\0';
    if (fuzzy) {
      if (actual.trim() !== expected[k]!.trim()) return false;
    } else if (actual !== expected[k]) {
      return false;
    }
  }
  return true;
}

function buildReplacement(
  hunkLines: PatchLine[],
  lines: string[],
  pos: number,
  fuzzy: boolean,
): string[] {
  const out: string[] = [];
  let k = pos;
  for (const hl of hunkLines) {
    switch (hl.kind) {
      case 'context':
        // keep the original line to preserve its exact whitespace
        out.push(fuzzy ? (lines[k] ?? hl.text) : hl.text);
        k++;
        break;
      case 'remove':
        k++; // dropped
        break;
      case 'add':
        out.push(hl.text);
        break;
    }
  }
  return out;
}
