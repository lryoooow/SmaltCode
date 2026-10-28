import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { ProcessManager, prepareLaunch, processEnvironment } from '../src/main/process-manager';
import { ProjectOperations } from '../src/main/project-operations';
import { backgroundShell, processTools } from '../src/main/process-tools';
import { shellTool } from '../../kernel/src/tools/defs/shell';
import { PermissionService } from '../../kernel/src/permissions/service';
import { parseRule } from '../../kernel/src/permissions/rules';

let root: string, cwd: string, manager: ProcessManager, inputAllowed: boolean;
const handles: Array<{ output: (data: string) => void; exit: (event: { exitCode: number }) => void; writes: string[]; killed: boolean; resize: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smalt-process-')); cwd = join(root, '工作区'); mkdirSync(cwd); inputAllowed = true; handles.length = 0;
  manager = new ProcessManager({ directory: root, runtime: root, thread: id => ({ cwd, archived: id === 'archived' }), canInput: () => inputAllowed, notify: () => {}, spawn: () => {
    const handle = { output: (_: string) => {}, exit: (_: { exitCode: number }) => {}, writes: [] as string[], killed: false, resize: vi.fn() }; handles.push(handle);
    return { pid: handles.length + 40000, onData: (listener: typeof handle.output) => { handle.output = listener; return { dispose() {} }; }, onExit: (listener: typeof handle.exit) => { handle.exit = listener; return { dispose() {} }; }, write: (data: string) => handle.writes.push(data), resize: handle.resize, kill: () => { handle.killed = true; handle.exit({ exitCode: 1 }); } } as unknown as IPty;
  } });
});
afterEach(async () => { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('owned background processes and terminal capabilities', () => {
  it('requires stopping before conversation deletion and durably removes only that conversation history', async () => {
    const first=await manager.start('a',{program:process.execPath},'user');
    expect(()=>manager.forgetThread('a')).toThrow('停止');
    handles[0].exit({exitCode:0});await manager.shutdown();
    manager.forgetThread('a');await manager.shutdown();expect(manager.list()).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root,'processes.json'),'utf8'))).toEqual([]);
  });

  it('isolates reads, input, resize and stop by conversation; never accepts a raw machine PID', async () => {
    const first = await manager.start('a', { program: process.execPath, args: ['--version'] }, 'user');
    const second = await manager.start('b', {}, 'user', true);
    expect(manager.list('a').map(value => value.id)).toEqual([first.id]);
    expect(() => manager.read('b', first.id)).toThrow('不属于');
    expect(() => manager.write('a', second.id, 'x')).toThrow('不属于');
    expect(() => manager.resize('a', second.id, 80, 20)).toThrow('不属于');
    await expect(manager.stop('b', first.id)).rejects.toThrow('不属于');
    await expect(manager.stop('a', '40001')).rejects.toThrow('不属于');
    await manager.stop('a', first.id); expect(handles[0]!.killed).toBe(true); expect(handles[1]!.killed).toBe(false);
  });
  it('requires separate live terminal authority; background jobs have no input channel', async () => {
    const terminal = await manager.start('a', {}, 'user', true);
    manager.write('a', terminal.id, '中文\r'); expect(handles[0]!.writes).toEqual(['中文\r']);
    manager.revokeInput('a'); expect(() => manager.write('a', terminal.id, 'x')).toThrow('未授权');
    manager.authorizeInput('a', terminal.id); inputAllowed = false;
    expect(() => manager.write('a', terminal.id, 'x')).toThrow('未授权');
    await expect(manager.start('a', {}, 'user', true)).rejects.toThrow('权限');
    const background = await manager.start('a', { program: process.execPath }, 'model');
    expect(() => manager.write('a', background.id, 'x')).toThrow('未授权');
    expect(() => manager.resize('a', terminal.id, 0, 0)).toThrow('尺寸');
  });
  it('bounds output and concurrency; duplicate project actions reuse only their own running process', async () => {
    const first = await manager.start('a', { program: process.execPath }, 'project', false, 'script:dev');
    const duplicate = await manager.start('a', { program: process.execPath }, 'project', false, 'script:dev'); expect(duplicate.id).toBe(first.id);
    handles[0]!.output('中'.repeat(100000)); const result = manager.read('a', first.id);
    expect(result.output.data).toHaveLength(65536); expect(result.output.end).toBe(100000); expect(result.process.truncated).toBe(true);
    for (let i=0;i<7;i++) await manager.start('a', { program: process.execPath }, 'user');
    await expect(manager.start('a', { program: process.execPath }, 'user')).rejects.toThrow('上限');
    await expect(manager.start('archived', { program: process.execPath }, 'user')).rejects.toThrow('归档');
  });
  it('persists exit evidence, treats unclean records as interrupted and never reuses their PIDs', async () => {
    const first = await manager.start('a', { program: process.execPath }, 'user'); handles[0]!.output('raw output'); handles[0]!.exit({ exitCode: 7 });
    await manager.shutdown(); const saved = JSON.parse(readFileSync(join(root, 'processes.json'), 'utf8'));
    saved[0].meta.state='running'; saved[0].meta.pid=process.pid; writeFileSync(join(root, 'processes.json'), JSON.stringify(saved));
    const restored = new ProcessManager({ directory: root, runtime: root, thread: () => ({ cwd }), canInput: () => true, notify: () => {}, spawn: () => { throw Error('must not spawn'); } });
    expect(restored.list()[0]).toMatchObject({ state: 'interrupted', pid: undefined, inputAllowed: false });
    expect(restored.read('a', first.id).output.data).toBe('raw output'); await restored.stop('a', first.id); await restored.shutdown();
  });
  it('fails closed on damaged history and preserves original bytes', async () => {
    await manager.shutdown(); const original='{invalid'; writeFileSync(join(root, 'processes.json'), original);
    const broken = new ProcessManager({ directory: root, runtime: root, thread: () => ({ cwd }), canInput: () => true, notify: () => {} });
    expect(broken.recoveryNotice).toContain('原文件'); await expect(broken.start('a', { program: process.execPath }, 'user')).rejects.toThrow('原文件'); await broken.shutdown();
    expect(readFileSync(join(root, 'processes.json'),'utf8')).toBe(original);
  });
  it('checks cwd, mode and command policy before running; never gives the model terminal input', async () => {
    expect(() => prepareLaunch(cwd, { program: process.execPath, cwd: '..' })).toThrow('工作区');
    expect(() => prepareLaunch(cwd, { command: 'echo x', program: 'node' })).toThrow('混用');
    expect(() => prepareLaunch(cwd, { program: 'powershell.exe' })).toThrow('解释器');
    const permission = new PermissionService([parseRule('shell:rm', 'user')], [], []);
    permission.setMode('plan'); expect(permission.check({ tool: 'shell', input: { background: true }, subject: 'node test.js', cwd }).action).toBe('deny');
    expect(permission.check({ tool: 'process_stop', input: {}, subject: 'stop-owned-process x', cwd }).action).toBe('deny');
    expect(processTools(manager).map(tool => tool.name)).toEqual(['process_read','process_stop']);
    const tool = backgroundShell(shellTool, manager), events = [];
    for await (const event of tool.run({ program: process.execPath, background: true }, { threadId: 'a', cwd, signal: new AbortController().signal } as any)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'result', assessment: { exitCode: null } });
  });
  it('strips model keys and runtime injection variables from inherited process environment', () => {
    vi.stubEnv('OPENAI_API_KEY','must-not-inherit'); vi.stubEnv('NODE_OPTIONS','--inspect'); vi.stubEnv('ELECTRON_RUN_AS_NODE','1');
    const env = processEnvironment(); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(env.TERM).toBe('xterm-256color'); vi.unstubAllEnvs();
  });
});

describe('reviewable project operations', () => {
  it('does not execute on discovery and refuses scripts changed after review, including pre/post hooks', () => {
    const operations = new ProjectOperations(root);
    writeFileSync(join(cwd,'package.json'), JSON.stringify({ scripts: { test:'node test.js', pretest:'node prepare.js' } }));
    const first = operations.list(cwd).operations.find(value => value.id==='package:test')!; expect(first.launch).toEqual({ program:'npm',args:['run','test'] }); expect(handles).toHaveLength(0);
    writeFileSync(join(cwd,'package.json'), JSON.stringify({ scripts: { test:'node test.js', pretest:'node changed.js' } }));
    expect(() => operations.resolve(cwd,first.id,first.digest)).toThrow('已变化');
  });
  it('keeps custom operations in local app data and bounds/validates directories and arguments', () => {
    const operations = new ProjectOperations(root); operations.save(cwd,'Node 信息',{program:process.execPath,args:['--version']});
    const item = operations.list(cwd).operations.find(value=>value.origin==='custom')!; expect(item.title).toBe('Node 信息');
    expect(() => operations.save(cwd,'escape',{program:process.execPath,cwd:'..'})).toThrow('工作区'); operations.remove(cwd,item.id); expect(operations.list(cwd).operations.some(value=>value.id===item.id)).toBe(false);
  });
});
