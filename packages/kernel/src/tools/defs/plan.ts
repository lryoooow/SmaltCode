import type { PlanStep } from '../../protocol/types.js';
import type { ToolDefinition, ToolEvent } from '../types.js';

/**
 * plan — the agent's shared todo list (TodoWrite-style). Steps are surfaced as
 * a PlanItem the UI renders as a checklist; using it keeps long tasks on
 * track and shows the user progress.
 */
export const planTool: ToolDefinition = {
  name: 'plan',
  description: `Record or update the plan for the current task. Use it at the start of non-trivial work and after completing each step.

Statuses: pending → inProgress → completed. Submitting the full list replaces the previous one.`,
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        maxItems: 200,
        description: 'The complete current plan',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this step does (short)' },
            status: { type: 'string', enum: ['pending', 'inProgress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  subject: () => 'plan',
  summarize: () => 'update plan',
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { steps } = input as { steps: Array<{ content: string; status: string }> };
    const normalized: PlanStep[] = steps.map((s) => ({
      content: String(s.content ?? ''),
      status: s.status === 'inProgress' || s.status === 'completed' ? s.status : 'pending',
    }));
    await ctx.emitItem({
      kind: 'plan',
      payload: { steps: normalized },
    });
    const done = normalized.filter((s) => s.status === 'completed').length;
    yield {
      type: 'result',
      text: `Plan updated: ${done}/${normalized.length} steps completed.`,
    };
  },
};
