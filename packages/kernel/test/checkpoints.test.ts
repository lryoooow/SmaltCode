import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointStore } from '../src/storage/checkpoints.js';
let root: string, cwd: string, store: CheckpointStore;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'smalt-cp-')); cwd = join(root, 'workspace'); await mkdir(cwd); store = new CheckpointStore(join(root, 'backups')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function change(path: string, before: string | null, after: string | null) {
  if (before !== null) await writeFile(join(cwd, path), before);
  const cp = await store.capture('thread', 'turn', cwd, '修改 ' + path, [path]);
  if (after !== null) await writeFile(join(cwd, path), after); else await unlink(join(cwd, path));
  await store.complete(cp); return cp;
}
describe('durable file checkpoints', () => {
  it('keeps healthy checkpoints visible when another record is malformed', async () => {
    const cp = await change('good.txt', 'before', 'after');
    await writeFile(join(root, 'backups', 'thread', 'bad.json'), '{broken');
    expect((await store.list('thread', cwd)).map(item => item.id)).toEqual([cp.id]);
    await expect(store.list('thread', cwd, 'bad')).rejects.toThrow();
  });
  it.each([[null, 'new'], ['old', 'updated'], ['old', null]] as Array<[string | null, string | null]>)('restores create/update/delete across a store restart (%s, %s)', async (before, after) => {
    const cp = await change('file.txt', before, after), restarted = new CheckpointStore(join(root, 'backups'));
    expect((await restarted.list('thread', cwd, cp.id))[0].files[0]).toMatchObject({ path: 'file.txt', restored: false, conflict: undefined });
    await restarted.restore('thread', cp.id, cwd, undefined, () => {});
    if (before === null) await expect(readFile(join(cwd, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); else expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe(before);
    expect((await restarted.list('thread', cwd))[0].files[0].restored).toBe(true);
  });
  it('protects manual edits and validates all files before restoring any', async () => {
    await writeFile(join(cwd, 'a'), 'old-a'); await writeFile(join(cwd, 'b'), 'old-b');
    const cp = await store.capture('thread', 'turn', cwd, 'two files', ['a', 'b']);
    await writeFile(join(cwd, 'a'), 'new-a'); await writeFile(join(cwd, 'b'), 'new-b'); await store.complete(cp);
    await writeFile(join(cwd, 'b'), 'manual');
    await expect(store.restore('thread', cp.id, cwd, undefined, () => {})).rejects.toThrow('恢复冲突');
    expect(await readFile(join(cwd, 'a'), 'utf8')).toBe('new-a'); expect(await readFile(join(cwd, 'b'), 'utf8')).toBe('manual');
    await store.restore('thread', cp.id, cwd, ['a'], () => {});
    expect(await readFile(join(cwd, 'a'), 'utf8')).toBe('old-a'); expect(await readFile(join(cwd, 'b'), 'utf8')).toBe('manual');
  });
  it('refuses traversal, foreign workspaces, unknown files and unfinished records', async () => {
    await expect(store.capture('thread', 'turn', cwd, '', ['../outside'])).rejects.toThrow('超出');
    await expect(store.list('../thread', cwd)).rejects.toThrow('无效');
    const cp = await store.capture('thread', 'turn', cwd, '', ['new.txt']);
    await expect(store.restore('thread', cp.id, cwd, undefined, () => {})).rejects.toThrow('尚未完整');
    await writeFile(join(cwd, 'new.txt'), 'after'); await store.complete(cp);
    await expect(store.restore('thread', cp.id, cwd, ['other.txt'], () => {})).rejects.toThrow('未记录');
    await expect(store.list('thread', root)).rejects.toThrow('不匹配');
  });
  it('rejects symlink swaps and never changes the external file', async () => {
    const cp = await change('file.txt', 'old', 'new'); const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file.txt'), 'private');
    await unlink(join(cwd, 'file.txt'));
    try { await symlink(join(outside, 'file.txt'), join(cwd, 'file.txt')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return; throw e; }
    await expect(store.restore('thread', cp.id, cwd, undefined, () => {})).rejects.toThrow();
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('private');
  });
  it('does not retain no-op checkpoints and respects workspace activity before a restore', async () => {
    await writeFile(join(cwd, 'same'), 'same'); const noop = await store.capture('thread', 'turn', cwd, '', ['same']); await store.complete(noop);
    expect(await store.list('thread', cwd)).toEqual([]);
    const cp = await change('changed', 'before', 'after');
    await expect(store.restore('thread', cp.id, cwd, undefined, () => { throw new Error('任务仍在运行'); })).rejects.toThrow('仍在运行');
    expect(await readFile(join(cwd, 'changed'), 'utf8')).toBe('after');
  });
});

it('blocks a parent directory junction swapped after an edit', async () => {
  await mkdir(join(cwd, 'nested')); const cp = await change('nested/file.txt', 'old', 'new');
  await rm(join(cwd, 'nested'), { recursive: true }); const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'file.txt'), 'private');
  await symlink(outside, join(cwd, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(store.restore('thread', cp.id, cwd, undefined, () => {})).rejects.toThrow('超出');
  expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('private');
});
