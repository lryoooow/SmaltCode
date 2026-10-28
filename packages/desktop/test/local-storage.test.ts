import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalSpaces } from '../src/main/local-spaces';
import { configureDesktopStorage, copyLocalData, nonSystemDrives } from '../src/main/desktop-storage';

let directory: string, home: string;
beforeEach(() => { directory = mkdtempSync(join(process.cwd(), '.qa-work/local-storage-')); home = join(directory, 'Data'); mkdirSync(home); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('independent local conversation storage', () => {
  it('selects only fixed-drive candidates other than the system drive, preferring D without assuming C is always the system', () => {
    expect(nonSystemDrives(['C:', 'E:', 'd:', 'D:\\', '\\\\server\\share', '/tmp', 'F:'], 'C:')).toEqual(['D:\\', 'E:\\', 'F:\\']);
    expect(nonSystemDrives(['C:', 'D:', 'E:'], 'D:')).toEqual(['C:\\', 'E:\\']);
  });
  it('honors an explicit local data profile and never probes or migrates unrelated user data', () => {
    let called = false;
    expect(configureDesktopStorage({ appData: directory, userHome: directory, explicitHome: home, platform: 'win32', drives: () => { called = true; return []; } })).toBe(home);
    expect(called).toBe(false);
  });
  it('fails clearly instead of silently saving to a system or network disk when there is no data disk', () => {
    expect(() => configureDesktopStorage({ appData: directory, userHome: directory, platform: 'win32', systemDrive: 'C:', drives: () => ['C:', '\\\\server\\share'] })).toThrow('未找到可写');
    expect(readdirSync(directory)).toEqual(['Data']);
  });
  it('copies history, binary attachments and empty folders with verification while preserving the source', () => {
    const source = join(directory, 'legacy'), target = join(directory, 'new', 'Data'); mkdirSync(join(source, 'empty'), { recursive: true });
    const bytes = Buffer.from([0, 255, 3, 7]); writeFileSync(join(source, 'attachment.data'), bytes); writeFileSync(join(source, 'history.jsonl'), '{"t":"meta"}\n');
    copyLocalData(source, target);
    expect(readFileSync(join(target, 'attachment.data'))).toEqual(bytes);
    expect(readFileSync(join(source, 'attachment.data'))).toEqual(bytes);
    expect(readFileSync(join(target, 'history.jsonl'), 'utf8')).toBe('{"t":"meta"}\n');
    expect(existsSync(join(target, 'empty'))).toBe(true);
    expect(() => copyLocalData(source, target)).toThrow('未合并或覆盖');
  });
  it.skipIf(process.platform !== 'win32')('publishes a verified non-system data home and reopens that same history through its local pointer', () => {
    const userHome = join(directory, 'user'), appData = join(directory, 'appData'), legacy = join(userHome, '.smalt'); mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'history.jsonl'), '{"history":"preserve-local"}\n');
    const drive = directory.slice(0, 2), system = drive.toUpperCase() === 'C:' ? 'Z:' : 'C:';
    const chosen = configureDesktopStorage({ appData, userHome, platform: 'win32', systemDrive: system, drives: () => [system, drive], directory: () => join(directory, 'application') });
    expect(readFileSync(join(chosen, 'history.jsonl'), 'utf8')).toBe('{"history":"preserve-local"}\n');
    expect(readFileSync(join(legacy, 'history.jsonl'), 'utf8')).toBe('{"history":"preserve-local"}\n');
    expect(configureDesktopStorage({ appData, userHome, platform: 'win32', systemDrive: system, drives: () => { throw new Error('must use the saved local pointer'); } })).toBe(chosen);
  });
  it('does not follow directory links during data relocation or grant them as local spaces', () => {
    const source = join(directory, 'legacy'), elsewhere = join(directory, 'elsewhere'); mkdirSync(source); mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'private'), 'unchanged');
    symlinkSync(elsewhere, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => copyLocalData(source, join(directory, 'target'))).toThrow('目录链接');
    expect(readFileSync(join(elsewhere, 'private'), 'utf8')).toBe('unchanged');
    const spaces = new LocalSpaces(home), a = spaces.create(); renameSync(a.cwd, a.cwd + '-original'); symlinkSync(elsewhere, a.cwd, process.platform === 'win32' ? 'junction' : 'dir');
    expect(spaces.owns(a.cwd)).toBe(false);
  });
  it('allocates separate leaves, never authorizes the root or an unregistered sibling, and restores ownership', () => {
    const spaces = new LocalSpaces(home), a = spaces.create(), b = spaces.create(), unknown = join(spaces.root, randomUUID()); mkdirSync(unknown);
    expect(a.cwd).not.toBe(b.cwd); expect(spaces.owns(a.cwd)).toBe(true); expect(spaces.owns(spaces.root)).toBe(false); expect(spaces.owns(unknown)).toBe(false);
    expect(new LocalSpaces(home).owns(a.cwd)).toBe(true);
    expect(dirname(a.cwd)).not.toBe(home);
  });
  it('prevents parallel creation or a second conversation from reusing a claimed private space', () => {
    const spaces = new LocalSpaces(home), a = spaces.create(); spaces.reserve(a.cwd);
    expect(() => spaces.reserve(a.cwd)).toThrow('属于另一段'); spaces.finish(a.cwd); spaces.reserve(a.cwd); spaces.finish(a.cwd, 'thread-a');
    expect(() => spaces.reserve(a.cwd)).toThrow('属于另一段');
    expect(() => new LocalSpaces(home).reserve(a.cwd)).toThrow('属于另一段');
  });
  it('quarantines a damaged allocation index without deleting files or preventing new local conversations', () => {
    const a = new LocalSpaces(home).create(); writeFileSync(join(a.cwd, 'draft.txt'), 'keep'); writeFileSync(join(home, 'local-spaces.json'), '{broken');
    const recovered = new LocalSpaces(home); expect(recovered.notice).toContain('原记录已保留'); expect(recovered.create().cwd).not.toBe(a.cwd);
    expect(readFileSync(join(a.cwd, 'draft.txt'), 'utf8')).toBe('keep'); expect(readdirSync(home).some(name => name.includes('.corrupt-'))).toBe(true);
  });
  it('keeps a missing recorded data disk explicit instead of opening a new empty history elsewhere', () => {
    const appData = join(directory, 'appData'); mkdirSync(join(appData, 'SmaltCode'), { recursive: true });
    writeFileSync(join(appData, 'SmaltCode', 'storage-location.json'), JSON.stringify({ version: 1, home: 'Z:\\missing-data-2d4c9f' }));
    expect(() => configureDesktopStorage({ appData, userHome: directory, platform: 'win32', systemDrive: 'C:', drives: () => ['D:'] })).toThrow('未改用系统盘或创建空历史');
  });
});
