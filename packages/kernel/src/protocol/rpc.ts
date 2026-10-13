/** JSON-RPC 2.0 message types and newline-delimited framing. */

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** application errors raised by kernel code */
  KernelError: -32000,
  Timeout: -32001,
  Cancelled: -32002,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !('method' in m);
}

export function encodeMessage(m: JsonRpcMessage): string {
  return `${JSON.stringify(m)}\n`;
}

/** Parse one framed line. Returns null for blank lines. Throws RpcError for malformed JSON. */
export function decodeLine(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new RpcError(RpcErrorCode.ParseError, 'Parse error');
  }
  return validateMessage(parsed);
}

function validateMessage(value: unknown): JsonRpcMessage {
  if (typeof value !== 'object' || value === null) {
    throw new RpcError(RpcErrorCode.InvalidRequest, 'Invalid Request');
  }
  const m = value as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') {
    throw new RpcError(RpcErrorCode.InvalidRequest, "jsonrpc must be '2.0'");
  }
  if (typeof m.method === 'string') {
    if ('id' in m && (typeof m.id === 'number' || typeof m.id === 'string')) {
      return { jsonrpc: '2.0', id: m.id, method: m.method, params: m.params };
    }
    if (!('id' in m)) {
      return { jsonrpc: '2.0', method: m.method, params: m.params };
    }
    throw new RpcError(RpcErrorCode.InvalidRequest, 'id must be string or number');
  }
  if ('result' in m || 'error' in m) {
    if (!('id' in m) || (typeof m.id !== 'number' && typeof m.id !== 'string' && m.id !== null)) {
      throw new RpcError(RpcErrorCode.InvalidRequest, 'response requires an id');
    }
    if ('result' in m && 'error' in m) {
      throw new RpcError(RpcErrorCode.InvalidRequest, 'response cannot have both result and error');
    }
    if ('result' in m) {
      if (m.id === null) {
        throw new RpcError(RpcErrorCode.InvalidRequest, 'success response requires a non-null id');
      }
      return { jsonrpc: '2.0', id: m.id, result: m.result };
    }
    const err = m.error as { code?: unknown; message?: unknown };
    return {
      jsonrpc: '2.0',
      id: m.id,
      error: {
        code: typeof err.code === 'number' ? err.code : RpcErrorCode.InternalError,
        message: typeof err.message === 'string' ? err.message : 'Internal error',
      },
    };
  }
  throw new RpcError(RpcErrorCode.InvalidRequest, 'Invalid Request');
}
