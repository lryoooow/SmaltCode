/**
 * glob + grep — high-throughput non-blocking file & content search.
 *
 * Uses local `rg` (ripgrep) asynchronously when available on PATH for native
 * multi-threaded speed + full `.gitignore` support, and falls back seamlessly
 * to an async `.gitignore`-aware filesystem walker with periodic event-loop
 * yields so Electron's main process never freezes even without `rg`.
 *
 * Security invariants enforced identically on BOTH paths:
 *  - `isInsideWorkspace(ctx.cwd, file)`
 *  - `!isSensitivePath(ctx.cwd, file)`
 *  - `ctx.canReadPath?.(file) ?? true`
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { resolveWorkspacePath } from '../../config/settings.js';
import { isInsideWorkspace, isSensitivePath } from '../workspace-guard.js';
import { truncate } from '../../util.js';
import type { ToolDefinition, ToolEvent } from '../types.js';

const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  '.next',
  'target',
  '__pycache__',
  '.venv',
]);
const MAX_FILES_SCANNED = 25_000;
const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

let rgAvailable: boolean | null = null;

interface GitignoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function compileGitignorePattern(rawLine: string): GitignoreRule | null {
  let line = rawLine.replace(/\r$/, '');
  if (!line || line.startsWith('#')) return null;
  if (!line.endsWith('\\ ')) line = line.trimEnd();
  if (!line) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;

  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  let expr = anchored ? '^' : '(?:^|/)';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '*') {
      if (line[i + 1] === '*') {
        if (line[i + 2] === '/') {
          expr += '(?:.*/)?';
          i += 2;
        } else {
          expr += '.*';
          i++;
        }
      } else {
        expr += '[^/]*';
      }
    } else if (ch === '?') {
      expr += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      expr += `\\${ch}`;
    } else {
      expr += ch;
    }
  }
  expr += dirOnly ? '(?:/|$)' : '(?:$|/)';
  try {
    return { negated, dirOnly, anchored, regex: new RegExp(expr) };
  } catch {
    return null;
  }
}

async function loadGitignoreRules(dir: string): Promise<GitignoreRule[]> {
  try {
    const raw = await readFile(join(dir, '.gitignore'), 'utf8');
    if (raw.length > 128 * 1024) return [];
    const rules: GitignoreRule[] = [];
    for (const line of raw.split('\n')) {
      const rule = compileGitignorePattern(line);
      if (rule) rules.push(rule);
    }
    return rules;
  } catch {
    return [];
  }
}

function isIgnoredByRules(
  relFromRuleBase: string,
  isDir: boolean,
  scopes: Array<{ base: string; rules: GitignoreRule[] }>,
  fullPath: string,
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    if (!scope.rules.length) continue;
    const rel = relative(scope.base, fullPath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    const candidate = isDir ? `${rel}/` : rel;
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir && !rel.includes('/')) continue;
      if (rule.regex.test(candidate) || rule.regex.test(rel)) {
        ignored = !rule.negated;
      }
    }
  }
  void relFromRuleBase;
  return ignored;
}

async function walkAsync(
  root: string,
  workspaceRoot: string,
  opts: {
    respectIgnores: boolean;
    budget: { count: number; ticks: number };
    signal?: AbortSignal;
    scopes: Array<{ base: string; rules: GitignoreRule[] }>;
  },
  out: string[],
): Promise<void> {
  if (opts.signal?.aborted || opts.budget.count <= 0) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const localRules = opts.respectIgnores ? await loadGitignoreRules(root) : [];
  const nextScopes = localRules.length ? [...opts.scopes, { base: root, rules: localRules }] : opts.scopes;

  for (const entry of entries) {
    if (opts.signal?.aborted || opts.budget.count-- <= 0) return;
    if (++opts.budget.ticks % 250 === 0) await yieldEventLoop();
    const full = join(root, entry.name);
    if (isSensitivePath(workspaceRoot, full) || isSensitivePath(root, full)) continue;
    if (entry.isDirectory()) {
      if (opts.respectIgnores && DEFAULT_IGNORES.has(entry.name)) continue;
      if (opts.respectIgnores && isIgnoredByRules(entry.name, true, nextScopes, full)) continue;
      await walkAsync(full, workspaceRoot, { ...opts, scopes: nextScopes }, out);
    } else if (entry.isFile()) {
      if (opts.respectIgnores && isIgnoredByRules(entry.name, false, nextScopes, full)) continue;
      out.push(full);
    }
  }
}

async function runRipgrep(args: string[], cwd: string, signal?: AbortSignal, maxBytes = 4 * 1024 * 1024): Promise<{ ok: true; stdout: string; exitCode: number } | { ok: false }> {
  if (signal?.aborted) return { ok: true, stdout: '', exitCode: 130 };
  if (rgAvailable === false) return { ok: false };
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('rg', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      rgAvailable = false;
      resolvePromise({ ok: false });
      return;
    }
    let stdout = '';
    let bytes = 0;
    let settled = false;
    const finish = (res: { ok: true; stdout: string; exitCode: number } | { ok: false }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolvePromise(res);
    };
    const onAbort = () => {
      child.kill();
      finish({ ok: true, stdout, exitCode: 130 });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: true, stdout, exitCode: 124 });
    }, 15_000);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      rgAvailable = true;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes <= maxBytes) {
        stdout += chunk;
      } else {
        child.kill();
      }
    });
    child.on('error', () => {
      rgAvailable = false;
      finish({ ok: false });
    });
    child.on('close', (code) => {
      if (code === null && rgAvailable === null) {
        finish({ ok: false });
        return;
      }
      rgAvailable = true;
      finish({ ok: true, stdout, exitCode: code ?? 0 });
    });
  });
}

function globSegmentToRegex(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        out += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const close = p.indexOf('}', i + 1);
      if (close > i + 1) {
        const alts = p.slice(i + 1, close).split(',').map((s) => globSegmentToRegex(s));
        out += `(?:${alts.join('|')})`;
        i = close;
      } else {
        out += '\\{';
      }
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  return new RegExp(`^${globSegmentToRegex(p)}$`, 'i');
}

function baseDirOfPattern(pattern: string): { dir: string; rest: string } {
  const norm = pattern.replace(/\\/g, '/');
  const parts = norm.split('/');
  const staticParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('{') || part.includes('[') || part === '') break;
    staticParts.push(part);
  }
  if (!staticParts.length) return { dir: '', rest: norm };
  return { dir: staticParts.join('/'), rest: parts.slice(staticParts.length).join('/') };
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.test.js"). Respects .gitignore and skips common build/VCS directories.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern; ** crosses directories, * within one segment' },
      path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
    },
    required: ['pattern'],
  },
  subject: (input) => String((input as Record<string, unknown>)?.path ?? ''),
  summarize: (input) => `glob ${(input as Record<string, unknown>)?.pattern}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { pattern, path } = input as { pattern: string; path?: string };
    const searchRoot = path ? resolveWorkspacePath(ctx.cwd, path) : ctx.cwd;
    const { dir, rest } = baseDirOfPattern(pattern);
    if (!rest && dir) {
      const target = join(searchRoot, dir);
      if (isInsideWorkspace(ctx.cwd, target) && !isSensitivePath(ctx.cwd, target) && (ctx.canReadPath?.(target) ?? true)) {
        try {
          const st = await stat(target);
          if (st.isFile()) {
            yield { type: 'result', text: relative(searchRoot, target).replace(/\\/g, '/') + '\n(1 matches)' };
            return;
          }
        } catch { /* absent literal */ }
      }
    }
    const root = dir ? join(searchRoot, dir) : searchRoot;
    const effective = rest || pattern;

    // N4: a pattern like `../outside/**` must not enumerate outside names
    if (!isInsideWorkspace(ctx.cwd, root)) {
      yield {
        type: 'result',
        text: `Error: glob root escapes the workspace (${root}). Search within the project directory.`,
        isError: true,
      };
      return;
    }

    if (ctx.signal?.aborted) {
      yield { type: 'result', text: 'Interrupted', isError: true };
      return;
    }
    let files: string[] | null = null;
    const rootSt = await stat(root).catch(() => null);
    if (rootSt?.isDirectory()) {
      const rg = await runRipgrep(
        ['--files', '--no-config', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', effective, '--color', 'never'],
        root,
        ctx.signal,
      );
      if (rg.ok && (rg.exitCode === 130 || rg.exitCode === 124)) {
        yield { type: 'result', text: rg.exitCode === 130 ? 'Interrupted' : 'Error: glob timed out', isError: true };
        return;
      }
      if (rg.ok && (rg.exitCode === 0 || rg.exitCode === 1)) {
        files = rg.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(0, MAX_FILES_SCANNED)
          .map((rel) => resolve(root, rel));
      }
    }

    if (!files) {
      files = [];
      await walkAsync(
        root,
        ctx.cwd,
        { respectIgnores: true, budget: { count: MAX_FILES_SCANNED, ticks: 0 }, signal: ctx.signal, scopes: [] },
        files,
      );
    }

    const re = globToRegExp(effective);
    const matches = files
      .filter((f) => isInsideWorkspace(ctx.cwd, f) && !isSensitivePath(ctx.cwd, f) && (ctx.canReadPath?.(f) ?? true))
      .filter((f) => re.test(relative(root, f).replace(/\\/g, '/')))
      .map((f) => relative(searchRoot, f).replace(/\\/g, '/'))
      .sort()
      .slice(0, MAX_RESULTS);

    yield {
      type: 'result',
      text: matches.length
        ? truncate(matches.join('\n'), 20_000) + `\n(${matches.length} matches)`
        : 'No files matched.',
    };
  },
};

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search file CONTENTS for a pattern (regex when valid, otherwise literal). Respects .gitignore and returns `path:line:text` matches. Prefer this over reading many files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (or literal if the regex is invalid)' },
      path: { type: 'string', description: 'File or directory to search (default: workspace root)' },
      include: { type: 'string', description: 'Glob filter for file names, e.g. "*.ts"' },
      maxResults: { type: 'number', description: 'Cap on returned matches (default 200)' },
    },
    required: ['pattern'],
  },
  subject: (input) => String((input as Record<string, unknown>)?.path ?? ''),
  summarize: (input) => `grep ${(input as Record<string, unknown>)?.pattern}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { pattern, path, include, maxResults } = input as {
      pattern: string;
      path?: string;
      include?: string;
      maxResults?: number;
    };
    const searchRoot = path ? resolveWorkspacePath(ctx.cwd, path) : ctx.cwd;
    if (!isInsideWorkspace(ctx.cwd, searchRoot)) {
      yield {
        type: 'result',
        text: `Error: search root escapes the workspace (${searchRoot}). Search within the project directory.`,
        isError: true,
      };
      return;
    }

    let rootStat;
    try {
      rootStat = await stat(searchRoot);
    } catch (err) {
      yield { type: 'result', text: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
      return;
    }

    let re: RegExp | null = null;
    let literal = false;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      literal = true;
    }

    const cap = Math.min(maxResults ?? MAX_RESULTS, 1000);
    const root0 = rootStat.isFile() ? join(searchRoot, '..') : searchRoot;

    // Fast path: async ripgrep when available and regex is standard
    if (!rootStat.isFile()) {
      const rgArgs = [
        '--no-config',
        '--line-number',
        '--with-filename',
        '--no-heading',
        '--color',
        'never',
        '--hidden',
        '--max-filesize',
        '2M',
        '-i',
        '--glob',
        '!.git',
        '--glob',
        '!node_modules',
      ];
      if (include) rgArgs.push('--glob', include);
      if (literal) rgArgs.push('-F');
      rgArgs.push('--', pattern, '.');
      const rg = await runRipgrep(rgArgs, searchRoot, ctx.signal);
      if (rg.ok && (rg.exitCode === 130 || rg.exitCode === 124)) {
        yield { type: 'result', text: rg.exitCode === 130 ? 'Interrupted' : 'Error: grep timed out', isError: true };
        return;
      }
      if (rg.ok && (rg.exitCode === 0 || rg.exitCode === 1)) {
        const results: string[] = [];
        for (const rawLine of rg.stdout.split(/\r?\n/)) {
          if (!rawLine) continue;
          const m = /^(?:\.[\\/])?(.+?):(\d+):(.*)$/.exec(rawLine);
          if (!m) continue;
          const absFile = resolve(searchRoot, m[1]!);
          if (!isInsideWorkspace(ctx.cwd, absFile) || isSensitivePath(ctx.cwd, absFile) || !(ctx.canReadPath?.(absFile) ?? true)) {
            continue;
          }
          const relPath = relative(root0, absFile).replace(/\\/g, '/');
          results.push(`${relPath}:${m[2]}:${m[3]!.trim().slice(0, 240)}`);
          if (results.length >= cap) break;
        }
        yield {
          type: 'result',
          text: results.length
            ? truncate(results.join('\n'), 20_000) + `\n(${results.length} matches)`
            : 'No matches found.',
        };
        return;
      }
    }

    // Universal async fallback: non-blocking .gitignore-aware walk + async file reads
    const files: string[] = [];
    if (rootStat.isFile()) {
      files.push(searchRoot);
    } else {
      await walkAsync(
        searchRoot,
        ctx.cwd,
        { respectIgnores: true, budget: { count: MAX_FILES_SCANNED, ticks: 0 }, signal: ctx.signal, scopes: [] },
        files,
      );
    }

    const includeRe = include ? globToRegExp(include) : null;
    const includeHasSlash = Boolean(include && include.replace(/\\/g, '/').includes('/'));
    const results: string[] = [];
    let fileIdx = 0;

    outer: for (const file of files) {
      if (ctx.signal?.aborted) break;
      if (++fileIdx % 40 === 0) await yieldEventLoop();
      if (isSensitivePath(ctx.cwd, file) || !isInsideWorkspace(ctx.cwd, file) || !(ctx.canReadPath?.(file) ?? true)) continue;
      if (includeRe) {
        const relPath = relative(root0, file).replace(/\\/g, '/');
        const baseName = file.replace(/\\/g, '/').split('/').pop() ?? '';
        if (includeHasSlash ? !includeRe.test(relPath) : (!includeRe.test(baseName) && !includeRe.test(relPath))) continue;
      }
      let content: string;
      try {
        const st = await stat(file);
        if (st.size > MAX_FILE_BYTES) continue;
        content = await readFile(file, 'utf8');
        if (content.includes('\u0000')) continue;
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n]!;
        const hit = literal ? line.toLowerCase().includes(pattern.toLowerCase()) : re!.test(line);
        if (hit) {
          results.push(`${relative(root0, file).replace(/\\/g, '/')}:${n + 1}:${line.trim().slice(0, 240)}`);
          if (results.length >= cap) break outer;
        }
      }
    }

    yield {
      type: 'result',
      text: results.length
        ? truncate(results.join('\n'), 20_000) + `\n(${results.length} matches)`
        : 'No matches found.',
    };
  },
};
