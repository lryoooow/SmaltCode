import { readFileSync, statSync } from 'node:fs';
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
    let content: string;
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        yield { type: 'result', text: `Error: ${path} is a directory (use glob or grep instead)`, isError: true };
        return;
      }
      if (st.size > 5 * 1024 * 1024) {
        yield { type: 'result', text: `Error: ${path} is ${(st.size / 1024 / 1024).toFixed(1)} MB — too large to read whole; use offset/limit or grep`, isError: true };
        return;
      }
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      yield { type: 'result', text: `Error reading ${path}: ${err instanceof Error ? err.message : err}`, isError: true };
      return;
    }

    if (content.includes('\u0000')) {
      yield { type: 'result', text: `Error: ${path} looks like a binary file`, isError: true };
      return;
    }

    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Math.floor(offset ?? 1));
    const end = limit ? Math.min(lines.length, start + limit - 1) : lines.length;

    const out: string[] = [];
    for (let n = start; n <= end; n++) {
      out.push(`${String(n).padStart(6)}\t${lines[n - 1] ?? ''}`);
    }
    const body = out.join('\n');
    yield {
      type: 'result',
      text: truncate(`${body}\n(${end - start + 1} of ${lines.length} lines)`, MAX_OUTPUT),
    };
  },
};
