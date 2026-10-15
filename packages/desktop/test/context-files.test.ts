import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readContextFile, resolveContext, searchContextFiles } from '../src/main/context-files.js';
let root: string, cwd: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'smalt-context-')); cwd = join(root, 'workspace'); await mkdir(cwd); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('explicit file and text-selection context', () => {
  it('indexes nested files, skips dependencies/config and returns workspace-relative names', async () => {
    await mkdir(join(cwd, 'docs')); await writeFile(join(cwd, 'docs/中文说明.md'), 'notes');
    await mkdir(join(cwd, 'node_modules')); await writeFile(join(cwd, 'node_modules/private.md'), 'ignored');
    await mkdir(join(cwd, '.git')); await writeFile(join(cwd, '.git/config'), 'ignored'); await writeFile(join(cwd, '.env'), 'secret');
    expect((await searchContextFiles(cwd, '')).files).toEqual(['docs/中文说明.md']);
  });
  it('includes only the selected Unicode text and detects stale selections', async () => {
    await writeFile(join(cwd, 'notes.md'), '第一行\r\n选中😀内容\r\n保留');
    const file = await readContextFile(cwd, 'notes.md'), start = file.text.indexOf('选中'), end = start + '选中😀内容'.length;
    const refs = [{ path: 'notes.md', start, end, digest: file.digest }];
    const result = await resolveContext(cwd, refs); expect(result.text).toContain('选中😀内容'); expect(result.text).not.toContain('第一行'); expect(result.text).toContain('startLine'); expect(result.references).toEqual([{ path: 'notes.md', label: 'notes.md:L2' }]);
    await writeFile(join(cwd, 'notes.md'), 'someone edited this');
    await expect(resolveContext(cwd, refs)).rejects.toThrow('选区已失效');
  });
  it('bounds large sources, rejects invalid ranges and cannot read outside the workspace', async () => {
    await writeFile(join(cwd, 'large.md'), 'x'.repeat(25000));
    expect((await resolveContext(cwd, [{ path: 'large.md' }])).text).toContain('"truncated":true');
    await expect(resolveContext(cwd, [{ path: 'large.md', start: -1, end: 3, digest: '' }])).rejects.toThrow('失效');
    await expect(resolveContext(cwd, [{ path: '../secret.md' }])).rejects.toThrow('超出');
    await expect(resolveContext(cwd, Array(11).fill({ path: 'large.md' }))).rejects.toThrow('10');
    await expect(resolveContext(cwd, Array(3).fill({ path: 'large.md' }))).rejects.toThrow('64000');
  });
  it('rejects binary files and symlinks escaping the workspace', async () => {
    await writeFile(join(cwd, 'binary'), Buffer.from([1, 0, 2])); await expect(readContextFile(cwd, 'binary')).rejects.toThrow('文本');
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await searchContextFiles(cwd, 'secret')).files).toEqual([]);
    await expect(resolveContext(cwd, [{ path: 'link/secret' }])).rejects.toThrow('超出');
  });
});
