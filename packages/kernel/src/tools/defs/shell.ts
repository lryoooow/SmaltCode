import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve, delimiter, extname, isAbsolute } from 'node:path';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ToolDefinition, ToolEvent } from '../types.js';
import { budgetToolOutput } from '../../util.js';
import { displayCommand, executionAssessment } from '../../protocol/assessment.js';
import { isInsideWorkspace, isNetworkPath, isSensitivePath } from '../workspace-guard.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;

let cachedShell: { file: string; args: string[] } | null = null;
let cachedOverride: string | undefined;

/** live tool child processes, so hosts can reap them on quit */
const liveChildren = new Set<number>();

/** The desktop awaits reaping before allowing its final quit. Never reads PIDs from disk. */
export async function waitForToolProcesses(): Promise<void> {
  await Promise.all([...liveChildren].map(pid => new Promise<void>((resolve, reject) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve(); return; }
    if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }; resolve(); return; }
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => reject(new Error('工具进程清理超时')), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); try { process.kill(pid, 0); reject(new Error('工具进程仍未退出')); } catch { liveChildren.delete(pid); resolve(); } });
  })));
}

/** Kill every running tool child (process tree). Call on app shutdown. */
export function killAllToolProcesses(): void {
  for (const pid of liveChildren) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear();
}

/** bash when available (consistent cross-platform behaviour), else cmd on Windows. */
export function detectShell(): { file: string; args: string[] } {
  if (cachedShell && cachedOverride === process.env.SMALT_SHELL) return cachedShell;
  cachedOverride = process.env.SMALT_SHELL;
  if (process.env.SMALT_SHELL) {
    const file = process.platform === 'win32' ? process.env.SMALT_SHELL.replaceAll('/', '\\') : process.env.SMALT_SHELL;
    cachedShell = { file, args: /^cmd(?:\.exe)?$/i.test(basename(file)) ? ['/d', '/s', '/c'] : /^(?:pwsh|powershell)(?:\.exe)?$/i.test(basename(file)) ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] : ['-c'] };
    return cachedShell;
  }
  if (process.platform === 'win32') {
    // Git Bash ships with Git for Windows and is almost always on PATH
    try {
      const where = execSync('where bash.exe', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').map(p => p.trim()).find(p => existsSync(p) && !/[\\/]Windows[\\/]/i.test(p));
      if (where && existsSync(where)) {
        cachedShell = { file: where, args: ['-c'] };
        return cachedShell;
      }
    } catch {
      /* fall through to cmd */
    }
    cachedShell = { file: 'cmd.exe', args: ['/d', '/s', '/c'] };
    return cachedShell;
  }
  cachedShell = { file: '/bin/sh', args: ['-c'] };
  return cachedShell;
}

export function shellEnvironment(): string {
  const shell = detectShell();
  if (/^cmd(?:\.exe)?$/i.test(basename(shell.file))) return `Shell: ${shell.file} (Windows cmd.exe). Use cmd syntax: dir, type, findstr, cd /d, and & or && for chaining. Semicolon is not a command separator. Do not assume ls/head/tail or other Unix tools exist. Prefer read/glob/grep for file inspection. Keep nested command quotes intact.`;
  if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(basename(shell.file))) return `Shell: ${shell.file} (PowerShell). Use PowerShell syntax and quote native program arguments carefully. Prefer read/glob/grep for file inspection.`;
  return `Shell: ${shell.file} (POSIX syntax). Prefer read/glob/grep for file inspection.`;
}

export const shellTool: ToolDefinition = {
  name: 'shell',
  description:
    'Run ONE program with program + args (preferred for tests/builds; real process exit code), OR a command using the configured shell. Do not combine these modes. Optional cwd must stay inside the workspace. Do not append echo/grep/pipelines to checks: they can hide failure. Prefer read/glob/grep for inspection; missing Unix commands are not available automatically on Windows. Default timeout 120s.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      program: { type: 'string', description: 'Executable name or path, e.g. node, python, pnpm. No shell interpreters; use command for shell syntax.' },
      args: { type: 'array', maxItems: 1024, items: { type: 'string' }, description: 'Literal program arguments, e.g. ["--dir", "frontend", "exec", "vitest", "run"]. No shell escaping.' },
      cwd: { type: 'string', description: 'Working directory inside the current workspace; default is workspace root' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Optional timeout in milliseconds (default 120000)' },
    },
  },
  subject: input => displayCommand(input as Record<string, unknown>),
  // Include unquoted argv as well so existing high-risk guards see e.g. git reset --hard.
  subjects: input => {
    const p = input as Record<string, unknown>, args = Array.isArray(p.args) ? p.args : [];
    return [displayCommand(p), ...(typeof p.program === 'string' ? [[p.program, ...args].join(' '), [basename(p.program.replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, ''), ...args].join(' ')] : [])];
  },
  summarize: input => `$ ${displayCommand(input as Record<string, unknown>)}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { command, program, args = [], cwd: requestedCwd, timeoutMs } = input as { command?: string; program?: string; args?: string[]; cwd?: string; timeoutMs?: number };
    const structured = typeof program === 'string';
    const commandText = displayCommand(input as Record<string, unknown>);
    const invalid = (message: string): ToolEvent => ({ type: 'result', text: message, isError: true, assessment: { kind: 'error', code: 'invalidInvocation', summary: message } });
    if (structured === (typeof command === 'string') || !(structured ? program : command)?.trim()) { yield invalid('Provide exactly one of command or program + args.'); return; }
    if (!Array.isArray(args) || args.length > 1024 || args.some(a => typeof a !== 'string' || a.includes('\0')) || commandText.length > 128_000 || program?.includes('\0') || command?.includes('\0')) { yield invalid('Invalid program arguments or command length.'); return; }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) { yield invalid('timeoutMs must be a positive finite number.'); return; }
    if (requestedCwd !== undefined && (isNetworkPath(requestedCwd) || !isInsideWorkspace(ctx.cwd, requestedCwd) || isSensitivePath(ctx.cwd, requestedCwd))) { yield invalid('cwd must remain inside the authorized workspace and outside sensitive directories.'); return; }
    const cwd = requestedCwd === undefined ? ctx.cwd : resolve(ctx.cwd, requestedCwd);
    if (ctx.signal.aborted) { yield { type: 'result', text: 'Interrupted', isError: true }; return; }
    const shell = detectShell();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
    let file = structured ? program! : shell.file;
    let argv = structured ? args : [...shell.args, command!];
    let windowsCmd = !structured && process.platform === 'win32' && /^cmd(?:\.exe)?$/i.test(basename(shell.file));
    if (structured) {
      if (isNetworkPath(file) || /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript)(?:\.exe)?$/i.test(basename(file))) { yield invalid('Shell interpreters require command mode; program mode runs a single executable.'); return; }
      // Executable lookup uses the workspace/PATH, never a shell expression.
      if (process.platform === 'win32') {
        const extensions = extname(file) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
        const dirs = isAbsolute(file) || /[\\/]/.test(file) ? [''] : [cwd, ...(process.env.PATH ?? '').split(delimiter)];
        const found = dirs.flatMap(dir => extensions.map(ext => resolve(dir || cwd, file + ext))).find(p => existsSync(p));
        file = found ?? file;
        if (/\.(?:cmd|bat)$/i.test(file)) {
          // Node cannot spawn batch wrappers directly. Only a single conservatively quoted
          // invocation is allowed; complex literals belong in a native node/python executable.
          if (/["%!\r\n&|<>^()]/.test(file) || args.some(a => /["%!\r\n&|<>^()]/.test(a))) { yield invalid('Batch wrapper arguments contain shell syntax. Use a native executable for these literals.'); return; }
          argv = ['/d', '/s', '/c', `"${[file, ...args].map(a => `"${a}"`).join(' ')}"`];
          file = process.env.ComSpec ?? 'cmd.exe'; windowsCmd = true;
        }
      }
    }
    // cmd /s strips the outer pair. Node's normal argv escaping would insert
    // backslashes before inner quotes, corrupting e.g. python -c "...".
    if (windowsCmd && !structured) argv = [...shell.args, `"chcp 65001 >nul & ${command}"`];
    const child = spawn(file, argv, {
      cwd,
      env: { ...env, SMALT: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: windowsCmd,
    });

    if (child.pid && child.pid > 0) liveChildren.add(child.pid);
    child.on('close', () => liveChildren.delete(child.pid ?? -1));
    child.on('error', () => liveChildren.delete(child.pid ?? -1));

    let output = '';
    let diagnosticTail = '';
    const diagnostics = new Set<string>();
    const chunks: string[] = [];
    let wake: (() => void) | undefined;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const push = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      if (ctx.signal.aborted) return;
      output += text;
      const lines = (diagnosticTail + text).split(/\r?\n/);
      diagnosticTail = lines.pop()!.slice(-4000);
      for (const line of lines) {
        if (/Would reformat|files? would be reformatted|Code style issues|\b\d+ (?:failed|skipped)\b|^\s*FAIL\b|ELIFECYCLE|error TS\d+|Found \d+ errors?|\b\d+ problems?\b|error during build|Build failed|not recognized as an internal|command not found|unknown (?:option|argument)|unrecognized arguments?/i.test(line) && diagnostics.size < 80) diagnostics.add(line.slice(0, 500));
      }
      chunks.push(text);
      wake?.();
      // stream a rolling window; final result carries the tail
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', (chunk: Buffer) => push(stderrDecoder.write(chunk)));

    let killedByTimeout = false;
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      killTree();
    }, Math.max(1, Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, 600_000)));

    let exitCode: number | null = null;
    let closed = false;
    const done = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        exitCode = code;
        closed = true;
        wake?.();
        resolve();
      });
      child.on('error', (err) => {
        output += `\n[spawn error] ${err.message}`;
        exitCode = null;
        closed = true;
        wake?.();
        resolve();
      });
    });
    const abort = () => killTree();
    ctx.signal.addEventListener('abort', abort, { once: true });
    if (ctx.signal.aborted) abort();
    try {
      while (!closed || chunks.length) {
        while (chunks.length) yield { type: 'output', text: chunks.shift()! };
        if (!closed) await new Promise<void>(resolve => { wake = resolve; });
      }
      await done;
      output += stdoutDecoder.end() + stderrDecoder.end();
    } finally {
      clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', abort);
      if (!closed) killTree();
    }

    const trimmed = output.replace(/\r\n/g, '\n').trimEnd();
    const body = trimmed ? `\n${budgetToolOutput(trimmed, MAX_OUTPUT)}` : '';
    const assessment = executionAssessment(commandText, `${killedByTimeout ? '[timed out]' : ctx.signal.aborted ? '[interrupted]' : ''}\n${[...diagnostics].join('\n')}\n${trimmed}`, exitCode, structured ? 'process' : 'shell', cwd);
    yield {
      type: 'result',
      text: `[exit ${exitCode ?? '?'}]${killedByTimeout ? ' [timed out]' : ctx.signal.aborted ? ' [interrupted]' : ''}${body}${assessment.kind !== 'success' ? `\n[assessment: ${assessment.kind}] ${assessment.summary}` : ''}`,
      isError: assessment.kind === 'error' || assessment.kind === 'interrupted',
      assessment,
    };
  },
};
