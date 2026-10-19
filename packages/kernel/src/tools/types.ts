/**
 * Tool contracts. A tool streams events: transient output deltas followed by
 * one final result. Approval is decided by the orchestrator *before* run() is
 * ever called — tools themselves never ask.
 */

export type ToolEvent =
  | { type: 'output'; text: string }
  | { type: 'result'; text: string; isError?: boolean; assessment?: import('../protocol/assessment.js').ExecutionAssessment };

export interface ToolRunContext {
  cwd: string;
  threadId: string;
  turnId: string;
  itemId: string;
  signal: AbortSignal;
  approvalBatch?: { id: string; operations: Array<{ id: string; tool: string; title: string; input: unknown }> };
  /** emit an item-shaped side effect (plans, prompts) back into the turn */
  emitItem(item: { kind: string; payload: unknown }): Promise<void>;
  /** ask the human a question through the client (reverse RPC) */
  askUser(question: string, options?: string[]): Promise<string>;
  log(msg: string): void;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft-07 style object) for the input */
  readonly inputSchema: Record<string, unknown>;
  /**
   * What this call is about to touch — a shell command or a file path.
   * Feeds the permission chain and the approval prompt.
   */
  subject(input: unknown): string;
  /**
   * Multi-target tools override this to list EVERY touched path, so deny
   * rules cannot be dodged by bundling several files into one call.
   */
  subjects?(input: unknown): string[];
  /** Human-facing one-liner for the approval prompt / transcript. */
  summarize(input: unknown): string;
  run(input: unknown, ctx: ToolRunContext): AsyncIterable<ToolEvent>;
}

/** Tiny JSON-Schema-subset validator: enough for tool inputs. */
export function validateInput(
  schema: Record<string, unknown>,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'tool input must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  const required = (schema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in obj)) return { ok: false, error: `missing required parameter "${key}"` };
  }
  const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  for (const [key, value] of Object.entries(obj)) {
    const prop = props[key];
    if (!prop) continue; // unknown params are passed through
    const type = prop.type as string | undefined;
    if (!type) continue;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (type === 'number' && actual === 'number' && !Number.isFinite(value as number)) {
      return { ok: false, error: `parameter "${key}" must be a finite number` };
    }
    if (type !== actual && !(type === 'integer' && actual === 'number')) {
      return { ok: false, error: `parameter "${key}" must be of type ${type}` };
    }
  }
  return { ok: true, value: obj };
}
