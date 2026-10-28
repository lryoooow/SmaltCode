/**
 * Tool contracts. A tool streams events: transient output deltas followed by
 * one final result. Approval is decided by the orchestrator *before* run() is
 * ever called — tools themselves never ask.
 */

export type ToolEvent =
  | { type: 'output'; text: string }
  | { type: 'result'; text: string; isError?: boolean; assessment?: import('../protocol/assessment.js').ExecutionAssessment };

export interface ToolRunContext {
  /** Search tools must check every file, not only the initial directory. Host-owned. */
  canReadPath?: (path: string) => boolean;
  policy?: import('../core/run-policy.js').ToolPolicy;
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
  /** Host-managed external capabilities are scoped and can be revoked mid-turn. */
  available?(context: { cwd: string; threadId: string }): boolean;
  validate?(input: unknown): string | undefined;
  external?: { server: string; tool: string; origin: string };
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

/** Bounded recursive validation of the JSON Schema subset used by tools. */
export function validateInput(
  schema: Record<string, unknown>,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'tool input must be a JSON object' };
  }
  let nodes = 0, chars = 0;
  const ancestors = new Set<object>();
  const check = (rule: Record<string, any>, value: unknown, path: string, depth: number): string | undefined => {
    if (++nodes > 50000 || depth > 32) return `${path}: input structure exceeds validation limits`;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
    if (types.length && !types.some((type: string) => type === actual || type === 'integer' && Number.isSafeInteger(value))) return `${path}: must be of type ${types.join(' or ')}`;
    if (Array.isArray(rule.enum) && !rule.enum.some((option: unknown) => Object.is(option, value))) return `${path}: must be one of ${rule.enum.join(', ')}`;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `${path}: must be a finite number`;
      if (typeof rule.minimum === 'number' && value < rule.minimum) return `${path}: must be at least ${rule.minimum}`;
      if (typeof rule.maximum === 'number' && value > rule.maximum) return `${path}: must be at most ${rule.maximum}`;
    } else if (typeof value === 'string') {
      chars += value.length;
      if (chars > 4 * 1024 * 1024) return `${path}: total text exceeds 4 MB characters`;
      if (value.includes('\0')) return `${path}: null characters are not allowed`;
      if (typeof rule.minLength === 'number' && value.length < rule.minLength) return `${path}: text is too short (minimum ${rule.minLength})`;
      if (typeof rule.maxLength === 'number' && value.length > rule.maxLength) return `${path}: text is too long (maximum ${rule.maxLength})`;
    } else if (value !== null && typeof value === 'object') {
      if (ancestors.has(value)) return `${path}: cyclic input is not JSON`;
      ancestors.add(value);
      let error: string | undefined;
      if (Array.isArray(value)) {
        if (typeof rule.maxItems === 'number' && value.length > rule.maxItems) error = `${path}: too many entries (maximum ${rule.maxItems})`;
        else if (typeof rule.minItems === 'number' && value.length < rule.minItems) error = `${path}: too few entries (minimum ${rule.minItems})`;
        else for (let i = 0; i < value.length; i++) { error = check(rule.items ?? {}, value[i], `${path}[${i}]`, depth + 1); if (error) break; }
      } else {
        const obj = value as Record<string, unknown>, proto = Object.getPrototypeOf(obj);
        if (proto !== Object.prototype && proto !== null) error = `${path}: must be a JSON object`;
        for (const key of rule.required ?? []) if (!Object.hasOwn(obj, key)) { error ??= `${path}.${key}: missing required parameter`; break; }
        if (!error) for (const [key, child] of Object.entries(obj)) {
          const prop = Object.hasOwn(rule.properties ?? {}, key) ? rule.properties[key] : undefined;
          if (!prop && rule.additionalProperties === false) { error = `${path}.${key}: unknown parameter`; break; }
          error = check(prop ?? (typeof rule.additionalProperties === 'object' ? rule.additionalProperties : {}), child, `${path}.${key}`, depth + 1);
          if (error) break;
        }
      }
      ancestors.delete(value); return error;
    } else if (value !== null && !['boolean', 'number', 'string'].includes(typeof value)) return `${path}: must contain only JSON values`;
    return undefined;
  };
  const error = check(schema, input, '$', 0);
  return error ? { ok: false, error } : { ok: true, value: input as Record<string, unknown> };
}
