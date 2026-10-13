import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ToolDefinition, ToolEvent } from '../types.js';
import { truncate } from '../../util.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;

let cachedShell: { file: string; args: string[] } | null = null;

/** live tool child processes, so hosts can reap them on quit */
const liveChildren = new Set<number>();

/** Kill every running tool child (process tree). Call on app shutdown. */
export function killAllToolProcesses(): void {
  for (const pid of liveChildren) {
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
function detectShell(): { file: string; args: string[] } {
  if (cachedShell) return cachedShell;
  if (process.env.SMALT_SHELL) {
    const file = process.env.SMALT_SHELL;
    cachedShell = { file, args: /^cmd(?:\.exe)?$/i.test(basename(file)) ? ['/d', '/s', '/c'] : ['-c'] };
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

export const shellTool: ToolDefinition = {
  name: 'shell',
  description:
    'Run a shell command in the workspace directory and return its combined stdout/stderr. Commands run through bash when available. Use it for builds, tests, git, and inspection. Long-running commands time out (default 120s).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
  },
  subject: (input) => String((input as Record<string, unknown>)?.command ?? ''),
  summarize: (input) => `$ ${(input as Record<string, unknown>)?.command ?? ''}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { command, timeoutMs } = input as { command: string; timeoutMs?: number };
    if (ctx.signal.aborted) { yield { type: 'result', text: 'Interrupted', isError: true }; return; }
    const shell = detectShell();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
    const cmd = /^cmd(?:\.exe)?$/i.test(basename(shell.file)) ? `chcp 65001 >nul & ${command}` : command;
    const child = spawn(shell.file, [...shell.args, cmd], {
      cwd: ctx.cwd,
      env: { ...env, SMALT: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    liveChildren.add(child.pid ?? -1);
    child.on('close', () => liveChildren.delete(child.pid ?? -1));
    child.on('error', () => liveChildren.delete(child.pid ?? -1));

    let output = '';
    const chunks: string[] = [];
    let wake: (() => void) | undefined;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const push = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      if (ctx.signal.aborted) return;
      output += text;
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
      else child.kill('SIGKILL');
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
        exitCode = -1;
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
    const body = trimmed ? `\n${truncate(trimmed, MAX_OUTPUT)}` : '';
    yield {
      type: 'result',
      text: `[exit ${exitCode ?? '?'}]${killedByTimeout ? ' [timed out]' : ctx.signal.aborted ? ' [interrupted]' : ''}${body}`,
      isError: exitCode !== 0,
    };
  },
};
