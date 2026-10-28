/**
 * glob + grep — dependency-free file search.
 *
 * Walks the tree with a bounded budget, skips the usual VCS/node_modules
 * noise by default, and supports `**`, `*`, `?` in patterns (glob) plus
 * regex-or-literal matching (grep).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveWorkspacePath } from '../../config/settings.js';
import { isInsideWorkspace, isSensitivePath } from '../workspace-guard.js';
import { truncate } from '../../util.js';
import type { ToolDefinition, ToolEvent } from '../types.js';

const DEFAULT_IGNORES = ['node_modules', '.git', '.hg', '.svn', 'dist', 'out', '.next', 'target', '__pycache__', '.venv'];
const MAX_FILES_SCANNED = 20_000;
const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function walk(
  root: string,
  opts: { respectIgnores: boolean; budget: { count: number } },
  out: string[],
): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (opts.budget.count-- <= 0) return;
    const full = join(root, entry.name);
    if (isSensitivePath(root, full)) continue;
    if (entry.isDirectory()) {
      if (opts.respectIgnores && DEFAULT_IGNORES.includes(entry.name)) continue;
      walk(full, opts, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '^';
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
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`, 'i');
}

function baseDirOfPattern(pattern: string): { dir: string; rest: string } {
  const norm = pattern.replace(/\\/g, '/');
  const parts = norm.split('/');
  const staticParts: string[] = [];
  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part === '') break;
    staticParts.push(part);
  }
  if (!staticParts.length) return { dir: '', rest: norm };
  return { dir: staticParts.join('/'), rest: parts.slice(staticParts.length).join('/') };
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts", "**/*.test.js"). Returns matching paths, newest-first when possible. Common build/VCS directories are skipped.',
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
        try { if (statSync(target).isFile()) { yield { type: 'result', text: relative(searchRoot, target).replace(/\\/g, '/') + '\n(1 matches)' }; return; } } catch { /* absent literal */ }
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

    const files: string[] = [];
    walk(root, { respectIgnores: true, budget: { count: MAX_FILES_SCANNED } }, files);
    const re = globToRegExp(effective);
    const matches = files
      .filter((f) => ctx.canReadPath?.(f) ?? true)
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
    'Search file CONTENTS for a pattern (regex when valid, otherwise literal). Returns `path:line:text` matches. Prefer this over reading many files.',
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

    let re: RegExp | null = null;
    let literal = false;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      literal = true;
    }

    const files: string[] = [];
    try {
      const st = statSync(searchRoot);
      if (st.isFile()) files.push(searchRoot);
      else walk(searchRoot, { respectIgnores: true, budget: { count: MAX_FILES_SCANNED } }, files);
    } catch (err) {
      yield { type: 'result', text: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
      return;
    }

    const includeRe = include ? globToRegExp(include) : null;
    const results: string[] = [];
    const cap = Math.min(maxResults ?? MAX_RESULTS, 1000);
    const root0 = files.length && statSync(searchRoot).isFile() ? join(searchRoot, '..') : searchRoot;

    outer: for (const file of files) {
      if (isSensitivePath(ctx.cwd, file) || !isInsideWorkspace(ctx.cwd, file) || !(ctx.canReadPath?.(file) ?? true)) continue;
      if (includeRe && !includeRe.test(file.replace(/\\/g, '/').split('/').pop() ?? '')) continue;
      let content: string;
      try {
        if (statSync(file).size > MAX_FILE_BYTES) continue;
        content = readFileSync(file, 'utf8');
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
