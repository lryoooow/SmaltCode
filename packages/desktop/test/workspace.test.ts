import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { isValidWorkspace } from '../src/main/workspace.js';
describe('desktop workspace selection', () => {
  it.each(['\\\\unavailable.invalid\\share', '//unavailable.invalid/share', '\\\\?\\C:\\project', '\\\\.\\C:'])('rejects network/device paths before any filesystem access: %s', path => {
    expect(isValidWorkspace(path)).toMatchObject({ ok: false });
  });
  it('accepts a project directory and rejects files, home, and drive roots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smalt-workspace-'));
    try {
      writeFileSync(join(directory, 'file.txt'), 'x');
      expect(isValidWorkspace(directory)).toEqual({ ok: true });
      expect(isValidWorkspace(join(directory, 'file.txt')).ok).toBe(false);
      expect(isValidWorkspace(homedir()).ok).toBe(false);
      expect(isValidWorkspace(parse(directory).root).ok).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
