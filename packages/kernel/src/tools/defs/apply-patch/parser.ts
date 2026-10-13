/**
 * Parser for the `apply_patch` format.
 *
 * The wire format follows openai/codex (Apache-2.0) so models already trained
 * on it emit valid patches unchanged:
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   *** Move to: path/to/renamed.ts        (optional)
 *   @@ optional context anchor
 *    unchanged line
 *   -removed line
 *   +added line
 *   *** Add File: path/to/new.ts
 *   +content
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 *
 * Context lines anchor a hunk without line numbers, which keeps patches
 * robust when the file drifted slightly. Lines inside Add File that start
 * with `***` are escaped as `\***`.
 */

export type PatchLineKind = 'context' | 'remove' | 'add';

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchHunk {
  /** optional `@@` anchor text (informational; matching uses context lines) */
  anchor?: string;
  lines: PatchLine[];
}

export type PatchFile =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] };

export class PatchParseError extends Error {
  constructor(message: string, readonly lineNo: number) {
    super(`patch parse error at line ${lineNo}: ${message}`);
    this.name = 'PatchParseError';
  }
}

export function parsePatch(patch: string): PatchFile[] {
  const lines = patch.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let i = 0;
  let ended = false;

  // skip leading blank lines
  while (i < lines.length && lines[i]!.trim() === '') i++;

  if (i >= lines.length || lines[i]!.trim() !== '*** Begin Patch') {
    throw new PatchParseError('patch must start with "*** Begin Patch"', i + 1);
  }
  i++;

  while (i < lines.length) {
    const line = lines[i]!.trimEnd();

    if (line === '') {
      i++;
      continue;
    }
    if (line === '*** End Patch') {
      ended = true;
      i++;
      break;
    }

    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      if (!path) throw new PatchParseError('Update File requires a path', i + 1);
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const hunks: PatchHunk[] = [];
      while (i < lines.length && !lines[i]!.startsWith('*** ') && lines[i]!.trim() !== '') {
        const { hunk, next } = parseHunk(lines, i);
        hunks.push(hunk);
        i = next;
      }
      if (!hunks.length) throw new PatchParseError(`no hunks under Update File: ${path}`, i + 1);
      files.push({ kind: 'update', path, moveTo, hunks });
      continue;
    }

    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      if (!path) throw new PatchParseError('Add File requires a path', i + 1);
      i++;
      const content: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('+') || lines[i]!.startsWith('\\***'))) {
        let l = lines[i]!;
        l = l.startsWith('\\***') ? l.slice(1) : l.slice(1);
        if (l.startsWith('\\***')) l = l.slice(1); // `+\***` escapes content starting with `***`
        content.push(l);
        i++;
      }
      files.push({ kind: 'add', path, lines: content });
      continue;
    }

    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      if (!path) throw new PatchParseError('Delete File requires a path', i + 1);
      files.push({ kind: 'delete', path });
      i++;
      continue;
    }

    throw new PatchParseError(`unexpected line outside any file section: "${line.slice(0, 60)}"`, i + 1);
  }

  if (!ended) throw new PatchParseError('patch must end with "*** End Patch"', i + 1);
  if (lines.slice(i).some(line => line.trim())) throw new PatchParseError('unexpected content after End Patch', i + 1);
  if (!files.length) throw new PatchParseError('patch contains no file sections', i + 1);
  return files;
}

function parseHunk(lines: string[], start: number): { hunk: PatchHunk; next: number } {
  let i = start;
  let anchor: string | undefined;
  if (lines[i]!.startsWith('@@')) {
    anchor = lines[i]!.slice(2).trim();
    i++;
  }

  const out: PatchLine[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('***')) break;
    if (i > start && l.startsWith('@@')) break; // a new hunk begins
    if (l.trim() === '') break; // blank line ends the hunk (section separator)
    if (l.startsWith('+')) {
      out.push({ kind: 'add', text: l.slice(1) });
    } else if (l.startsWith('-')) {
      out.push({ kind: 'remove', text: l.slice(1) });
    } else {
      // context line — leading space is conventional but optional
      out.push({ kind: 'context', text: l.startsWith(' ') ? l.slice(1) : l });
    }
    i++;
  }

  if (!out.some((p) => p.kind !== 'context')) {
    throw new PatchParseError('hunk contains no +/- changes', i);
  }
  return { hunk: { anchor, lines: out }, next: i };
}
