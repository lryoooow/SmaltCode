/** Host-only execution bounds. Never accepted from model input or public JSON-RPC. */
export type RunPolicy = {
  maxRequests: number; maxTokens: number; maxTools: number; deadlineAt: number;
  unattended?: boolean; signal: AbortSignal;
  /** Trusted host capability restriction; never populated from RPC/model input. */
  toolPolicy?: ToolPolicy;
};
export type ToolPolicy = { allowedTools?: string[]; workspaceOnly?: boolean; noBackground?: boolean;
  check?: (tool: string, input: unknown, subjects: string[]) => string | undefined };
export type RunMetrics = { requests: number; chargedTokens: number; toolCalls: number };
export class RunLimit extends Error {
  constructor(readonly reason: 'requests' | 'tokens' | 'tools' | 'context' | 'deadline', message: string) { super(message); }
}
export const unattendedTools = ['read', 'glob', 'grep', 'plan'];
