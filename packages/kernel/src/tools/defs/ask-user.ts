import type { ToolDefinition, ToolEvent } from '../types.js';

/**
 * ask_user — when the agent genuinely cannot proceed without human input
 * (ambiguity, credentials, taste decisions). The kernel forwards the question
 * to the client as a reverse request and pauses the state machine on
 * waiting_for_user.
 */
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description:
    'Ask the human a clarifying question when you are blocked or a decision has real consequences. Do NOT use it for things you can verify yourself with tools. The answer comes back as your tool result.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask, with any needed context' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short answer choices the user can pick from',
      },
    },
    required: ['question'],
  },
  subject: () => 'ask_user',
  summarize: (input) => `ask: ${String((input as Record<string, unknown>)?.question ?? '').slice(0, 60)}`,
  async *run(input, ctx): AsyncIterable<ToolEvent> {
    const { question, options } = input as { question: string; options?: string[] };
    const answer = await ctx.askUser(question, options);
    yield { type: 'result', text: answer || '(no answer)' };
  },
};
