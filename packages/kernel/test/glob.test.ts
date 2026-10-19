import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globTool } from '../src/tools/defs/search.js';
import type { ToolRunContext } from '../src/tools/types.js';
let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'smalt-glob-')); for (const path of ['src/a.ts', 'src/nested/b.ts', 'packages/core/src/index.ts']) { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), 'fixture'); } });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
describe('glob directory and wildcard matching', () => {
  it.each([
    ['src/*.ts', ['src/a.ts']], ['src/**/*.ts', ['src/a.ts', 'src/nested/b.ts']],
    ['packages/*/src/index.ts', ['packages/core/src/index.ts']], ['src/**', ['src/a.ts', 'src/nested/b.ts']],
    ['src/a.ts', ['src/a.ts']],
  ] as const)('resolves %s to real workspace files', async (pattern, expected) => {
    let text = ''; for await (const event of globTool.run({ pattern }, { cwd } as ToolRunContext)) if (event.type === 'result') text = event.text;
    expect(text.split('\n').filter(line => !line.startsWith('('))).toEqual(expected);
  });
});
