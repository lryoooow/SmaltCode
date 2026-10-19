import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { resolveWorkspacePath } from '../../config/settings.js';
import { truncate } from '../../util.js';
import type { ToolDefinition, ToolEvent } from '../types.js';

const MAX_OUTPUT = 60_000;

export const readTool: ToolDefinition = {
  name: 'read',
  description:
    'Read a text file from the workspace. Returns the content prefixed with `cat -n` style line numbers. Use offset/limit for large files. Binary files are rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the workspace root' },
      offset: { type: 'number', description: '1-based line to start reading from' },
      limit: { type: 'number', description: 'Maximum number of lines to return' },
    },
    required: ['path'],
  },
  subject: (input) => String((input as Record<string, unknown>)?.path ?? ''),
  summarize: (input) => `read ${(input as Record<string, unknown>)?.path}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { path, offset, limit } = input as {
      path: string;
      offset?: number;
      limit?: number;
    };
    const abs = resolveWorkspacePath(ctx.cwd, path);
    if ((offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1)) ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) {
      yield { type: 'result', text: 'Error: offset and limit must be positive integers', isError: true };
      return;
    }
    let content: string;
    let fd: number | undefined;
    try {
      fd = openSync(abs, 'r');
      const st = fstatSync(fd);
      if (st.isDirectory()) {
        yield { type: 'result', text: `Error: ${path} is a directory (use glob or grep instead)`, isError: true };
        return;
      }
      if (st.size > 5 * 1024 * 1024) {
        yield { type: 'result', text: `Error: ${path} exceeds the 5 MB text-file limit; use grep or split the file`, isError: true };
        return;
      }
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
      let count = 0;
      while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
      if (count > 5 * 1024 * 1024) throw new Error('file grew beyond the 5 MB limit while reading');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } catch (err) {
      yield { type: 'result', text: `Error reading ${path}: ${err instanceof Error ? err.message : err}`, isError: true };
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    if (content.includes('\u0000')) {
      yield { type: 'result', text: `Error: ${path} looks like a binary file`, isError: true };
      return;
    }

    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Math.floor(offset ?? 1));
    const end = limit !== undefined ? Math.min(lines.length, start + limit - 1) : lines.length;

    const out: string[] = [];
    for (let n = start; n <= end; n++) {
      out.push(`${String(n).padStart(6)}\t${lines[n - 1] ?? ''}`);
    }
    const body = out.join('\n');
    yield {
      type: 'result',
      text: truncate(`${body}\n(${Math.max(0, end - start + 1)} of ${lines.length} lines)`, MAX_OUTPUT),
    };
  },
};
