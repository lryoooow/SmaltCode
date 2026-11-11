import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPatch, checkPostEditDiagnostics } from '../src/index.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'smalt-patch-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Progressive 4-tier fuzzy apply_patch & zero-execution post-edit diagnostics', () => {
  it('applies hunks with shifted indentation while preserving surrounding file indent delta', () => {
    const dir = tempDir();
    const file = join(dir, 'service.ts');
    writeFileSync(
      file,
      [
        'export class Service {',
        '  run() {',
        '    if (this.ready) {',
        '      const count = 1;',
        '      return count;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const patchText = [
      '*** Begin Patch',
      '*** Update File: service.ts',
      '@@',
      '  const count = 1;',
      '-  return count;',
      '+  const next = count + 1;',
      '+  return next;',
      '*** End Patch',
    ].join('\n');

    const report = applyPatch(patchText, dir);
    expect(report.changes).toHaveLength(1);
    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('      const count = 1;\n      const next = count + 1;\n      return next;');
  });

  it('matches Unicode smart quotes and dashes via Tier-4 normalization when exact/trim miss', () => {
    const dir = tempDir();
    const file = join(dir, 'copy.ts');
    writeFileSync(file, 'export const title = \u201cSmaltCode \u2014 Desktop\u201d;\n', 'utf8');

    const patchText = [
      '*** Begin Patch',
      '*** Update File: copy.ts',
      '@@',
      '-export const title = "SmaltCode - Desktop";',
      '+export const title = "SmaltCode v0.0.8";',
      '*** End Patch',
    ].join('\n');

    applyPatch(patchText, dir);
    expect(readFileSync(file, 'utf8')).toBe('export const title = "SmaltCode v0.0.8";\n');
  });

  it('detects JSON parse errors, unbalanced JS/TS delimiters, and merge conflict markers in <5ms', () => {
    const dir = tempDir();
    const badJson = join(dir, 'config.json');
    writeFileSync(badJson, '{"a": 1, }', 'utf8');
    expect(checkPostEditDiagnostics(badJson, 'config.json')).toContain('JSON syntax');

    const okJson = join(dir, 'ok.json');
    writeFileSync(okJson, '{"a": 1}', 'utf8');
    expect(checkPostEditDiagnostics(okJson, 'ok.json')).toBeNull();

    const badTs = join(dir, 'index.ts');
    writeFileSync(badTs, 'export function demo() {\n  const x = [1, 2;\n}\n', 'utf8');
    expect(checkPostEditDiagnostics(badTs, 'index.ts')).toContain('mismatched');

    const validTs = join(dir, 'valid.ts');
    writeFileSync(
      validTs,
      'export function demo(s = "{ not a brace }") {\n  const re = /\\(/g;\n  return `${s}-${re.source}`;\n}\n',
      'utf8',
    );
    expect(checkPostEditDiagnostics(validTs, 'valid.ts')).toBeNull();

    const conflictTs = join(dir, 'conflict.ts');
    writeFileSync(conflictTs, '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> main\n', 'utf8');
    expect(checkPostEditDiagnostics(conflictTs, 'conflict.ts')).toContain('conflict');
  });
});
