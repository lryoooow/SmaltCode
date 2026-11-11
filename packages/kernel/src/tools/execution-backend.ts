/**
 * ExecutionBackend — kernel-level abstraction decoupling file and command
 * operations from raw local `node:fs` / `child_process` calls so local,
 * worktree, SSH, and container environments can share a uniform contract.
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspacePath } from '../config/settings.js';

export interface BackendFileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
}

export interface BackendExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface BackendExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface ExecutionBackend {
  readonly kind: 'local' | 'ssh' | 'container' | 'worktree' | 'custom';
  readonly root: string;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<BackendFileStat | null>;
  exec(command: string, opts?: BackendExecOptions): Promise<BackendExecResult>;
}

export class LocalExecutionBackend implements ExecutionBackend {
  readonly kind: ExecutionBackend['kind'];

  constructor(readonly root: string, kind: ExecutionBackend['kind'] = 'local') {
    this.kind = kind;
  }

  private resolve(path: string): string {
    return resolveWorkspacePath(this.root, path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(this.resolve(path));
  }

  async readText(path: string): Promise<string> {
    return readFile(this.resolve(path), 'utf8');
  }

  async writeText(path: string, content: string): Promise<void> {
    const abs = this.resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { force: true });
  }

  async stat(path: string): Promise<BackendFileStat | null> {
    try {
      const abs = this.resolve(path);
      const lst = await lstat(abs);
      const st = lst.isSymbolicLink() ? await stat(abs).catch(() => lst) : lst;
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymbolicLink: lst.isSymbolicLink(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  async exec(command: string, opts: BackendExecOptions = {}): Promise<BackendExecResult> {
    const cwd = opts.cwd ? resolveWorkspacePath(this.root, opts.cwd) : this.root;
    const isWin = process.platform === 'win32';
    return new Promise<BackendExecResult>((resolve) => {
      const child = spawn(
        isWin ? 'cmd.exe' : '/bin/sh',
        isWin ? ['/d', '/s', '/c', command] : ['-c', command],
        {
          cwd,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, opts.timeoutMs)
        : undefined;
      timer?.unref?.();
      const onAbort = () => child.kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-128_000);
        opts.onStdout?.(chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-128_000);
        opts.onStderr?.(chunk);
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: -1, stdout, stderr: stderr + err.message, timedOut });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
  }
}
