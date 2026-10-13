/**
 * Unified internal message format. Adapters translate to/from provider wires
 * (OpenAI-compatible Chat Completions, Anthropic Messages, …) so the kernel
 * loop never sees provider-specific shapes.
 */

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  mimeType: string;
  /** base64, no data: prefix */
  dataBase64: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string, assembled from stream deltas */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; reasoningContent?: string }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argsDelta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: 'stop' | 'toolCalls' | 'length' | 'contentFilter' | 'other' };

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  images: boolean;
  contextWindow: number;
}

export type WireApi = 'chat' | 'anthropic';

export interface ModelAdapter {
  readonly wire: WireApi;
  stream(req: ModelRequest): AsyncIterable<ModelDelta>;
  readonly capabilities: ModelCapabilities;
}

/**
 * The minimal surface the turn runner and compactor need from a model source.
 * ModelGateway satisfies this structurally; tests provide fakes.
 */
export interface ModelStreamer {
  stream(ref: { provider: string; model: string }, req: Omit<ModelRequest, 'model'>): AsyncIterable<ModelDelta>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** Rough token estimate: CJK chars count ~1 token each, other text ~4 chars/token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    }
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateHistoryTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') total += estimateTokens(part.text);
        else total += 1000; // images: flat overhead estimate
      }
    }
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) total += estimateTokens(tc.arguments) + 16;
    }
  }
  return total;
}
