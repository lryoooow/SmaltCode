import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { isInsideWorkspace, isSensitivePath } from '@smalt/kernel';
import { isNetworkPath } from '../../../kernel/src/tools/workspace-guard.js';
import type { ManagedProcess, ProcessEvent, ProcessLaunch, ProcessOutput } from '../shared/processes.js';

const ACTIVE = new Set(['starting', 'running', 'stopping']);
const TAIL = 64 * 1024;
const READY = '\x1b]777;smalt-ready\x07';
type Entry = { meta: ManagedProcess; output: string; end: number; sent: number; pty?: IPty; settled: Promise<void>; settle: () => void; stop?: Promise<void> };
type Options = {
  directory: string; runtime: string; thread: (id: string) => { cwd: string; archived?: boolean };
  notify: (event: ProcessEvent) => void; canInput: (threadId: string) => boolean;
  spawn?: (file: string, args: string[], options: IPtyForkOptions) => IPty;
};
export function processEnvironment(): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^NODE_OPTIONS$|^ELECTRON_|^SMALT_)/i.test(entry[0]))), TERM: 'xterm-256color', COLORTERM: 'truecolor', PYTHONIOENCODING: 'utf-8', SMALT: '1' };
}
export function prepareLaunch(workspace: string, input: ProcessLaunch): { file: string; args: string[]; cwd: string; command: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的进程启动参数');
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 100)) throw new Error('进程名称无效');
  const structured = typeof input.program === 'string';
  if (structured === (typeof input.command === 'string')) throw new Error('请提供程序与参数，或一条命令，不能混用');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('程序参数无效，最多 256 项');
  if (!structured && args.length) throw new Error('命令模式不能另带程序参数');
  const cwd = resolve(workspace, input.cwd ?? '.');
  if (typeof input.cwd !== 'undefined' && typeof input.cwd !== 'string' || isNetworkPath(cwd) || !isInsideWorkspace(workspace, cwd) || isSensitivePath(workspace, cwd) || !statSync(cwd).isDirectory()) throw new Error('进程目录必须在当前工作区内，且不属于敏感路径');
  let file = input.program?.trim() ?? '', argv = [...args];
  const command = structured ? [file, ...args.map(arg => JSON.stringify(arg))].join(' ') : input.command!;
  if (!command.trim() || command.includes('\0') || Buffer.byteLength(command, 'utf8') > 8192) throw new Error('命令不能为空，且 UTF-8 长度不能超过 8192 字节');
  if (!structured) {
    if (process.platform === 'win32') { file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe'); argv = ['/d', '/s', '/c', '"chcp 65001 >nul & ' + input.command + '"']; }
    else { file = '/bin/sh'; argv = ['-c', input.command!]; }
  } else {
    if (isNetworkPath(file) || /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript)(?:\.exe)?$/i.test(basename(file))) throw new Error('结构化程序模式不接受 shell 解释器，请使用命令模式');
    const explicit = isAbsolute(file) || /[\\/]/.test(file);
    if (explicit && (!isInsideWorkspace(workspace, file) && !isAbsolute(file) || isSensitivePath(workspace, file))) throw new Error('程序路径超出工作区或属于敏感路径');
    const extensions = process.platform === 'win32' && !extname(file) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
    const directories = explicit ? [''] : (process.env.PATH ?? '').split(delimiter);
    const found = directories.flatMap(dir => extensions.map(ext => resolve(dir || cwd, file + ext))).find(path => { try { return statSync(path).isFile(); } catch { return false; } });
    if (!found) throw new Error('找不到程序：' + file);
    file = found;
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
      if (/["%!\r\n&|<>^()]/.test(file) || args.some(arg => /["%!\r\n&|<>^()]/.test(arg))) throw new Error('批处理包装器参数含 shell 语法，请改用原生程序');
      argv = ['/d', '/s', '/c', '"' + [file, ...args].map(arg => '"' + arg + '"').join(' ') + '"'];
      file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe');
    }
  }
  return { file, args: argv, cwd, command };
}

/** Owns only this app's processes. Disk records are evidence, never live PID authority. */
export class ProcessManager {
  private entries = new Map<string, Entry>();
  private closing = false;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  readonly recoveryNotice?: string;
  constructor(private readonly options: Options) {
    mkdirSync(options.directory, { recursive: true }); this.file = join(options.directory, 'processes.json');
    try {
      if (existsSync(this.file)) {
        if (statSync(this.file).size > 16 * 1024 * 1024) throw new Error('进程记录超过读取上限');
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!Array.isArray(saved)) throw new Error('进程记录格式无效');
        for (const value of saved.slice(-80)) {
          const meta = value?.meta as ManagedProcess;
          if (!meta || !/^proc_[a-f0-9-]{36}$/.test(meta.id) || typeof meta.threadId !== 'string' || typeof meta.cwd !== 'string' || typeof meta.workspace !== 'string' || typeof meta.title !== 'string' || typeof meta.command !== 'string' || typeof meta.startedAt !== 'string' || !Number.isFinite(Date.parse(meta.startedAt)) || meta.command.length > 8192 || meta.cwd.length > 4096 || meta.title.length > 100 || !['background', 'terminal'].includes(meta.kind) || !['starting', 'running', 'stopping', 'exited', 'failed', 'stopped', 'interrupted'].includes(meta.state)) continue;
          const restored = { ...meta, revision: (meta.revision ?? 0) + 1, pid: undefined, inputAllowed: false };
          if (ACTIVE.has(meta.state)) Object.assign(restored, { state: 'interrupted', endedAt: new Date().toISOString(), error: '上次应用未正常结束；进程不会自动重启，请检查结果后手动运行。' });
          this.entries.set(meta.id, { meta: restored, output: typeof value.output === 'string' ? value.output.slice(-TAIL) : '', end: typeof value.output === 'string' ? value.output.slice(-TAIL).length : 0, sent: 0, settled: Promise.resolve(), settle: () => {} });
        }
      }
    } catch (error) { this.recoveryNotice = '进程历史无法读取，已保留原文件；新进程暂不允许启动。' + (error instanceof Error ? error.message : ''); }
    this.flushTimer = setInterval(() => this.flush(), 100); this.flushTimer.unref();
  }
  list(threadId?: string): ManagedProcess[] { return [...this.entries.values()].filter(entry => !threadId || entry.meta.threadId === threadId).map(entry => ({ ...entry.meta })); }
  active(threadId?: string): ManagedProcess[] { return this.list(threadId).filter(meta => ACTIVE.has(meta.state)); }
  private owned(threadId: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.meta.threadId !== threadId) throw new Error('进程不属于当前对话或已不存在');
    return entry;
  }
  read(threadId: string, id: string): { process: ManagedProcess; output: ProcessOutput } {
    const entry = this.owned(threadId, id);
    return { process: { ...entry.meta }, output: { data: entry.output, from: entry.end - entry.output.length, end: entry.end } };
  }
  private emit(entry: Entry) { entry.meta.revision++; this.options.notify({ process: { ...entry.meta } }); this.persistSoon(); }
  private flush() {
    for (const entry of this.entries.values()) if (entry.end !== entry.sent) {
      const from = Math.max(entry.sent, entry.end - entry.output.length);
      this.options.notify({ process: { ...entry.meta }, output: { data: entry.output.slice(from - (entry.end - entry.output.length)), from, end: entry.end } });
      entry.sent = entry.end;
    }
  }
  private append(entry: Entry, data: string) {
    if (!data) return;
    entry.output = (entry.output + data).slice(-TAIL); entry.end += data.length;
    entry.meta.truncated ||= entry.end > TAIL; this.persistSoon();
  }
  private persistSoon() {
    if (this.recoveryNotice || this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.persist(); }, 1000); this.persistTimer.unref();
  }
  private persist() {
    const snapshot = JSON.stringify([...this.entries.values()].map(entry => ({ meta: { ...entry.meta, truncated: entry.meta.truncated || entry.output.length > 8192 }, output: entry.output.slice(-8192) })));
    const write = async () => { const temporary = this.file + '.' + randomUUID() + '.tmp'; await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, this.file); };
    this.writes = this.writes.then(write, write).catch(error => console.error('[process-history] save failed', error instanceof Error ? error.message : String(error)));
    return this.writes;
  }
  async start(threadId: string, input: ProcessLaunch, source: ManagedProcess['source'], terminal = false, actionId?: string): Promise<ManagedProcess> {
    if (this.closing || this.recoveryNotice) throw new Error(this.recoveryNotice ?? '应用正在退出，不能启动进程');
    const thread = this.options.thread(threadId);
    if (thread.archived) throw new Error('请先恢复归档对话');
    if (terminal && !this.options.canInput(threadId)) throw new Error('当前权限不允许交互终端');
    if (this.active(threadId).length >= 8 || this.active().length >= 24) throw new Error('后台进程达到上限：每对话 8 个，应用共 24 个');
    if (actionId) { const existing = this.active(threadId).find(meta => meta.actionId === actionId); if (existing) return existing; }
    const launch = terminal ? { file: process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash', args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc'], cwd: thread.cwd, command: process.platform === 'win32' ? 'PowerShell · 交互式终端' : 'bash · 交互式终端' } : prepareLaunch(thread.cwd, input);
    const meta: ManagedProcess = { id: 'proc_' + randomUUID(), revision: 1, threadId, workspace: thread.cwd, cwd: launch.cwd, title: (input.title?.trim() || (terminal ? '交互终端' : basename(launch.file))).slice(0, 100), command: launch.command, kind: terminal ? 'terminal' : 'background', source, state: 'starting', startedAt: new Date().toISOString(), inputAllowed: terminal, columns: 100, rows: 28, truncated: false, actionId };
    let settle!: () => void; const entry: Entry = { meta, output: '', end: 0, sent: 0, settled: new Promise(resolve => settle = resolve), settle: () => settle() };
    while (this.entries.size >= 80) { const oldest = [...this.entries.values()].find(value => !ACTIVE.has(value.meta.state)); if (!oldest) throw new Error('进程历史已满'); this.entries.delete(oldest.meta.id); }
    this.entries.set(meta.id, entry); this.emit(entry);
    try {
      const native = join(this.options.runtime, 'native').replace(/([\\/])app\.asar([\\/]|$)/i, '$1app.asar.unpacked$2');
      const driver = this.options.spawn ?? (require(join(native, 'node-pty')) as typeof import('node-pty')).spawn;
      const supervisor = join(native, 'SmaltProcessSupervisor.exe');
      const config = { file: launch.file, args: launch.args, parentPid: process.pid, parentStartedAt: Date.now() - process.uptime() * 1000 };
      const args = process.platform === 'win32' && !this.options.spawn ? [Buffer.from(JSON.stringify(config)).toString('base64')] : launch.args;
      const file = process.platform === 'win32' && !this.options.spawn ? supervisor : launch.file;
      const ptyOptions: IWindowsPtyForkOptions = { cwd: launch.cwd, env: processEnvironment(), name: 'xterm-256color', cols: meta.columns, rows: meta.rows, useConpty: true, useConptyDll: true };
      entry.pty = driver(file, args, ptyOptions);
      meta.pid = entry.pty.pid;
      let startup = '', ready = !!this.options.spawn || process.platform !== 'win32';
      entry.pty.onData(data => {
        if (!ready) {
          startup += data;
          const index = startup.indexOf(READY);
          if (index >= 0) { ready = true; meta.state = 'running'; this.append(entry, startup.slice(0, index) + startup.slice(index + READY.length)); startup = ''; this.emit(entry); }
          else if (startup.length > TAIL) { this.append(entry, startup.slice(0, -100)); startup = startup.slice(-100); }
        } else this.append(entry, data);
      });
      entry.pty.onExit(({ exitCode }) => {
        this.append(entry, startup); startup = '';
        const stopping = meta.state === 'stopping';
        meta.state = stopping ? 'stopped' : exitCode === 0 && ready ? 'exited' : 'failed';
        meta.exitCode = exitCode; meta.endedAt = new Date().toISOString(); meta.inputAllowed = false;
        if (!ready) meta.error = '进程未能建立隔离会话，请查看原始输出。';
        entry.pty = undefined; entry.settle(); this.flush(); this.emit(entry);
      });
      if (ready) meta.state = 'running'; this.emit(entry);
      const watchdog = setTimeout(() => { if (meta.state === 'starting') { meta.error = '进程启动确认超时，已请求停止'; void this.stop(threadId, meta.id).catch(() => {}); } }, 10_000); watchdog.unref();
      entry.settled.then(() => clearTimeout(watchdog));
      return { ...meta };
    } catch (error) {
      Object.assign(meta, { state: 'failed', error: error instanceof Error ? error.message : String(error), inputAllowed: false, endedAt: new Date().toISOString() }); entry.settle(); this.emit(entry); throw error;
    }
  }
  write(threadId: string, id: string, data: string): void {
    const entry = this.owned(threadId, id);
    if (this.closing || entry.meta.kind !== 'terminal' || entry.meta.state !== 'running' || !entry.meta.inputAllowed || !this.options.canInput(threadId)) throw new Error('终端输入未授权、已撤销或会话已结束');
    if (typeof data !== 'string' || data.length > 16_384) throw new Error('终端输入过长或无效');
    entry.pty!.write(data);
  }
  resize(threadId: string, id: string, columns: number, rows: number): void {
    const entry = this.owned(threadId, id);
    if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 20 || columns > 400 || rows < 5 || rows > 160) throw new Error('终端尺寸超出范围');
    if (entry.pty && ACTIVE.has(entry.meta.state)) { entry.pty.resize(columns, rows); entry.meta.columns = columns; entry.meta.rows = rows; }
  }
  revokeInput(threadId?: string) { for (const entry of this.entries.values()) if ((!threadId || entry.meta.threadId === threadId) && entry.meta.inputAllowed) { entry.meta.inputAllowed = false; this.emit(entry); } }
  authorizeInput(threadId: string, id: string) { const entry = this.owned(threadId, id); if (entry.meta.kind !== 'terminal' || entry.meta.state !== 'running' || !this.options.canInput(threadId)) throw new Error('当前任务权限不允许终端输入'); entry.meta.inputAllowed = true; this.emit(entry); }
  async stop(threadId: string, id: string): Promise<void> {
    const entry = this.owned(threadId, id);
    if (!ACTIVE.has(entry.meta.state)) return;
    if (entry.stop) return entry.stop;
    entry.meta.state = 'stopping'; entry.meta.inputAllowed = false; this.emit(entry);
    entry.stop = (async () => {
      entry.pty?.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([entry.settled, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('进程清理未确认完成，请重试停止；应用不会把它记为已停止')), 8000); })]).finally(() => clearTimeout(timer));
    })().catch(error => { entry.stop = undefined; entry.meta.error = error instanceof Error ? error.message : String(error); this.emit(entry); throw error; });
    return entry.stop;
  }
  forgetThread(threadId: string) {
    if (this.active(threadId).length) throw new Error('请先停止对话的后台进程');
    for (const [id, entry] of this.entries) if (entry.meta.threadId === threadId) this.entries.delete(id);
    this.persistSoon();
  }
  async stopThread(threadId: string) { await Promise.all(this.active(threadId).map(meta => this.stop(threadId, meta.id))); }
  async shutdown(): Promise<void> {
    this.closing = true; this.revokeInput();
    try { await Promise.all(this.active().map(meta => this.stop(meta.threadId, meta.id))); }
    catch (error) { this.closing = false; throw error; }
    if (this.flushTimer) clearInterval(this.flushTimer); this.flush();
    if (this.persistTimer) clearTimeout(this.persistTimer); if (!this.recoveryNotice && (this.entries.size || existsSync(this.file))) await this.persist();
  }
}
