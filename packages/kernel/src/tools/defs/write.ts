import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveWorkspacePath } from '../../config/settings.js';
import { unifiedDiff, diffPreview } from '../../util.js';
import type { ToolDefinition, ToolEvent } from '../types.js';

export const writeTool: ToolDefinition = {
  name: 'write',
  description:
    'Create a file or overwrite it with the full new content. ALWAYS read the existing file first when overwriting. For surgical edits to existing files prefer apply_patch.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the workspace root' },
      content: { type: 'string', description: 'Complete new file content' },
    },
    required: ['path', 'content'],
  },
  subject: (input) => String((input as Record<string, unknown>)?.path ?? ''),
  subjects: (input) => [String((input as Record<string, unknown>)?.path ?? '')].filter(Boolean),
  summarize: (input) => `write ${(input as Record<string, unknown>)?.path}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { path, content } = input as { path: string; content: string };
    const abs = resolveWorkspacePath(ctx.cwd, path);
    try {
      const existed = existsSync(abs);
      const before = existed ? readFileSync(abs, 'utf8') : '';
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      const diff = unifiedDiff(
        path,
        !before ? [] : before.endsWith('\n') ? before.slice(0, -1).split('\n') : before.split('\n'),
        content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n'),
      );
      await ctx.emitItem({ kind: 'fileChange', payload: { path, changeKind: existed ? 'update' : 'add', diff } });
      yield {
        type: 'result',
        text: `${existed ? 'Updated' : 'Created'} ${path}\n\n${diffPreview(diff)}`,
      };
    } catch (err) {
      yield { type: 'result', text: `Error writing ${path}: ${err instanceof Error ? err.message : err}`, isError: true };
    }
  },
};
