import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatch, PatchParseError } from '../src/tools/defs/apply-patch/parser.js';
import { applyPatch, ApplyError } from '../src/tools/defs/apply-patch/apply.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smalt-patch-'));
});

describe('parsePatch', () => {
  it('parses add + update + delete in one patch', () => {
    const patch = `*** Begin Patch
*** Add File: new.txt
+hello
+world
*** Update File: old.txt
@@
 ctx
-old line
+new line
*** Delete File: gone.txt
*** End Patch`;
    const files = parsePatch(patch);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ kind: 'add', path: 'new.txt' });
    expect((files[0] as { lines: string[] }).lines).toEqual(['hello', 'world']);
    expect(files[1]).toMatchObject({ kind: 'update', path: 'old.txt' });
    expect(files[2]).toMatchObject({ kind: 'delete', path: 'gone.txt' });
  });

  it('parses Move to', () => {
    const files = parsePatch(`*** Begin Patch
*** Update File: a.ts
*** Move to: b.ts
@@
-x
+y
*** End Patch`);
    expect(files[0]).toMatchObject({ kind: 'update', path: 'a.ts', moveTo: 'b.ts' });
  });

  it('unescapes literal *** lines in Add File', () => {
    const files = parsePatch(`*** Begin Patch
*** Add File: doc.md
+# Title
+\\*** not a directive
+body
*** End Patch`);
    expect((files[0] as { lines: string[] }).lines).toEqual(['# Title', '*** not a directive', 'body']);
  });

  it('rejects patches without a Begin marker', () => {
    expect(() => parsePatch('*** Update File: x\n-x\n+y')).toThrow(PatchParseError);
  });

  it('rejects hunks with no changes', () => {
    expect(() =>
      parsePatch('*** Begin Patch\n*** Update File: x\n@@\n context only\n*** End Patch'),
    ).toThrow(PatchParseError);
  });
});

describe('applyPatch', () => {
  it('applies an update hunk located by context', () => {
    writeFileSync(join(dir, 'app.ts'), ['import x from "y";', '', 'function main() {', '  const old = 1;', '  return old;', '}', ''].join('\n'));
    const report = applyPatch(
      `*** Begin Patch
*** Update File: app.ts
@@ function main()
 function main() {
-  const old = 1;
-  return old;
+  const fresh = 2;
+  return fresh;
 }
*** End Patch`,
      dir,
    );
    expect(report.summary).toContain('update app.ts');
    const after = readFileSync(join(dir, 'app.ts'), 'utf8');
    expect(after).toContain('const fresh = 2;');
    expect(after).not.toContain('const old = 1;');
  });

  it('falls back to whitespace-tolerant matching', () => {
    writeFileSync(join(dir, 'w.txt'), ['a', '   b   ', 'c', ''].join('\n'));
    applyPatch(
      `*** Begin Patch
*** Update File: w.txt
@@
 a
-b
+c
*** End Patch`,
      dir,
    );
    // b is REPLACED by c; the original c line stays
    expect(readFileSync(join(dir, 'w.txt'), 'utf8')).toBe('a\nc\nc\n');
  });

  it('adds and deletes files', () => {
    writeFileSync(join(dir, 'del.txt'), 'bye\n');
    const report = applyPatch(
      `*** Begin Patch
*** Add File: added.txt
+content here
*** Delete File: del.txt
*** End Patch`,
      dir,
    );
    expect(existsSync(join(dir, 'added.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'added.txt'), 'utf8')).toBe('content here\n');
    expect(existsSync(join(dir, 'del.txt'))).toBe(false);
    expect(report.changes.map((c) => c.action)).toEqual(['add', 'delete']);
  });

  it('moves a file with Move to', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'orig.ts'), 'export const a = 1;\n');
    applyPatch(
      `*** Begin Patch
*** Update File: orig.ts
*** Move to: nested/renamed.ts
@@
-export const a = 1;
+export const a = 2;
*** End Patch`,
      dir,
    );
    expect(existsSync(join(dir, 'orig.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'nested/renamed.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('applies multiple hunks in order', () => {
    writeFileSync(join(dir, 'multi.txt'), ['one', 'x', 'two', 'y', 'three', 'z', 'four', ''].join('\n'));
    applyPatch(
      `*** Begin Patch
*** Update File: multi.txt
@@
 one
-x
+X
@@
 three
-z
+Z
*** End Patch`,
      dir,
    );
    const after = readFileSync(join(dir, 'multi.txt'), 'utf8').split('\n');
    expect(after).toEqual(['one', 'X', 'two', 'y', 'three', 'Z', 'four', '']);
  });

  it('fails with a helpful error when context is missing', () => {
    writeFileSync(join(dir, 'x.txt'), 'unchanged\n');
    expect(() =>
      applyPatch(
        `*** Begin Patch
*** Update File: x.txt
@@
 not-in-file
-a
+b
*** End Patch`,
        dir,
      ),
    ).toThrow(ApplyError);
  });

  it('refuses to add an existing file', () => {
    writeFileSync(join(dir, 'exists.txt'), 'x\n');
    expect(() =>
      applyPatch('*** Begin Patch\n*** Add File: exists.txt\n+x\n*** End Patch', dir),
    ).toThrow(ApplyError);
  });
});

describe('patch correctness regressions', () => {
  it('accepts blank context and Add File lines without losing following changes', () => {
    writeFileSync(join(dir, 'blank.txt'), 'first\n\nold\nlast\n');
    applyPatch('*** Begin Patch\n*** Update File: blank.txt\n@@\n first\n\n-old\n+new\n last\n*** Add File: AddedCase.TS\n+first\n\n+last\n*** End Patch', dir);
    expect(readFileSync(join(dir, 'blank.txt'), 'utf8')).toBe('first\n\nnew\nlast\n');
    expect(readFileSync(join(dir, 'AddedCase.TS'), 'utf8')).toBe('first\n\nlast\n');
  });
  it('anchors End of File to the last occurrence instead of the first', () => {
    writeFileSync(join(dir, 'tail.txt'), 'same\nmiddle\nsame\n');
    applyPatch('*** Begin Patch\n*** Update File: tail.txt\n@@\n-same\n+last\n*** End of File\n*** End Patch', dir);
    expect(readFileSync(join(dir, 'tail.txt'), 'utf8')).toBe('same\nmiddle\nlast\n');
  });
  it.runIf(process.platform === 'win32')('preserves new filename case while sharing staged content across case aliases', () => {
    applyPatch('*** Begin Patch\n*** Add File: MyComponent.TSX\n+first\n*** Update File: mycomponent.tsx\n@@\n-first\n+second\n*** End Patch', dir);
    expect(readFileSync(join(dir, 'MyComponent.TSX'), 'utf8')).toBe('second\n');
    expect(require('node:fs').readdirSync(dir)).toContain('MyComponent.TSX');
  });
  it('does not partially write when a later file has invalid context', () => {
    writeFileSync(join(dir, 'a.txt'), 'original\n');
    writeFileSync(join(dir, 'b.txt'), 'other\n');
    expect(() => applyPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n-original\n+changed\n*** Update File: b.txt\n@@\n-missing\n+changed\n*** End Patch', dir)).toThrow(ApplyError);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('other\n');
  });
  it('preserves BOM, CRLF and the absence of a final newline', () => {
    writeFileSync(join(dir, 'note.txt'), '\uFEFFfirst\r\nlast');
    applyPatch('*** Begin Patch\n*** Update File: note.txt\n@@\n first\n-last\n+updated\n*** End Patch', dir);
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('\uFEFFfirst\r\nupdated');
  });
  it('supports sequential edits to a newly added file within the same patch', () => {
    applyPatch('*** Begin Patch\n*** Add File: new.txt\n+first\n*** Update File: new.txt\n@@\n-first\n+second\n*** End Patch', dir);
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('second\n');
  });
  it('does not overwrite an existing move destination', () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n'); writeFileSync(join(dir, 'b.txt'), 'b\n');
    expect(() => applyPatch('*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-a\n+c\n*** End Patch', dir)).toThrow(ApplyError);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b\n');
  });
  it('rejects a truncated patch without its end marker', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Add File: note.txt\n+partial')).toThrow(PatchParseError);
  });
});
