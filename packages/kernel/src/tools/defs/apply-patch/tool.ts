import { applyPatch } from './apply.js';
import { parsePatch } from './parser.js';
import type { ToolDefinition, ToolEvent } from '../../types.js';

/** every path a patch touches, including Move to targets */
export function patchTargets(patch: string): string[] {
  try {
    return parsePatch(patch).flatMap((f) => (f.kind === 'update' && f.moveTo ? [f.path, f.moveTo] : [f.path]));
  } catch {
    return [];
  }
}

export const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description: `Apply a patch to create, update, move, or delete files. Patches locate changes by surrounding context lines, NOT line numbers, so they stay valid after small file drift.

Format:
*** Begin Patch
*** Update File: path/to/file
@@ optional anchor
 unchanged context line
-removed line
+added line
*** Add File: path/to/new
+file content (escape literal '***' lines as '\\***')
*** Delete File: path/to/gone
*** End Patch

Rules:
- Context lines are copied from the CURRENT file content and must match exactly (whitespace-tolerant fallback exists).
- Include 1-3 context lines around every change.
- You may patch multiple files in one call.`,
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The full patch text, starting with *** Begin Patch' },
    },
    required: ['patch'],
  },
  subject: (input) => patchTargets(String((input as Record<string, unknown>)?.patch ?? '')).join(', ') || 'patch',
  subjects: (input) => patchTargets(String((input as Record<string, unknown>)?.patch ?? '')),
  summarize: (input) => {
    const patch = String((input as Record<string, unknown>)?.patch ?? '');
    const m = [...patch.matchAll(/\*\*\* (Update|Add|Delete) File: (.+)/g)]
      .map((x) => `${x[1]!.toLowerCase()} ${x[2]!.trim()}`)
      .slice(0, 4)
      .join(', ');
    return m || 'apply patch';
  },
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { patch } = input as { patch: string };
    try {
      const report = applyPatch(patch, ctx.cwd);
      for (const change of report.changes) {
        const moved = change.action === 'move' ? change.path.split(' → ') : null;
        if (moved) await ctx.emitItem({ kind: 'fileChange', payload: { path: moved[0], changeKind: 'delete' } });
        await ctx.emitItem({ kind: 'fileChange', payload: {
          path: moved?.[1] ?? change.path,
          changeKind: change.action === 'delete' ? 'delete' : change.action === 'add' || moved ? 'add' : 'update',
          diff: change.diff,
        } });
      }
      yield {
        type: 'result',
        text: `${report.summary}\n\n${report.changes
          .filter((c) => c.diff)
          .map((c) => c.diff)
          .join('\n\n')}`,
      };
    } catch (err) {
      yield {
        type: 'result',
        text: `Error: ${err instanceof Error ? err.message : err}\nRe-read the file and retry with fresh context lines.`,
        isError: true,
      };
    }
  },
};
