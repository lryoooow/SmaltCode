import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../src/storage/projects.js';
let dir: string, file: string, store: ProjectStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smalt-projects-')); file = join(dir, 'projects.json'); store = new ProjectStore(file); });
afterEach(() => { for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); rmdirSync(dir); });
it('keeps corrupt bytes untouched on read and preserves them before creating a new project', () => {
  writeFileSync(file, '{broken'); expect(store.list()).toEqual([]); expect(store.notice).toContain('原项目文件未覆盖'); expect(readFileSync(file, 'utf8')).toBe('{broken');
  const project = store.create({ name: '新项目' }); expect(store.list()).toEqual([project]); expect(store.notice).toBeUndefined();
  const saved = readdirSync(dir).find(name => name.includes('.corrupt-'))!; expect(readFileSync(join(dir, saved), 'utf8')).toBe('{broken');
});
it('recovers a valid backup without rewriting a malformed primary, then safely saves a repair', () => {
  const original = store.create({ name: '原项目' }); store.update(original.id, { name: '更新项目' }); writeFileSync(file, 'truncated');
  expect(store.list()).toEqual([original]); expect(store.notice).toContain('上次备份'); expect(readFileSync(file, 'utf8')).toBe('truncated');
  store.create({ name: '继续工作' }); expect(store.list().map(p => p.name)).toEqual(['原项目', '继续工作']);
  expect(readdirSync(dir).filter(name => name.includes('.corrupt-'))).toHaveLength(1);
});
it('isolates invalid and duplicate records while preserving valid project instructions', () => {
  const good = store.create({ name: '有效项目', instructions: '工作规则' });
  writeFileSync(file, JSON.stringify([null, {}, good, { ...good, name: '重复项目' }, { ...good, id: 'bad', instructions: 123 }]));
  expect(store.list()).toEqual([good]); expect(store.notice).toContain('4 条'); store.update(good.id, { name: '修复后' });
  expect(store.list()[0]).toMatchObject({ name: '修复后', instructions: '工作规则' });
});
it('does not resurrect a deleted project from backup when the primary is a valid empty array', () => {
  const p = store.create({ name: '项目' }); store.delete(p.id); expect(store.list()).toEqual([]); expect(store.notice).toBeUndefined();
});
it('handles malformed primary and backup independently, and never overwrites either during listing', () => {
  writeFileSync(file, '{}'); writeFileSync(file + '.bak', '[null]'); expect(store.list()).toEqual([]); expect(store.notice).toBeTruthy();
  expect(readFileSync(file, 'utf8')).toBe('{}'); expect(readFileSync(file + '.bak', 'utf8')).toBe('[null]');
});
