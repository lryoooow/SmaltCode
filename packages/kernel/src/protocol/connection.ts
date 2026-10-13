/**
 * A JSON-RPC 2.0 peer over a line-based transport (stdio by default).
 *
 * Both sides may send requests: the client drives the kernel (thread/start,
 * turn/start, …) and the kernel issues *reverse requests* (approval prompts,
 * user-input prompts). Timeouts, cancellation and correlation are handled by
 * the RPC layer itself, which keeps the kernel code free of bookkeeping.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import * as readline from 'node:readline';
import {
  decodeLine,
  encodeMessage,
  isRequest,
  isResponse,
  RpcError,
  RpcErrorCode,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from './rpc.js';

export interface Transport {
  write(line: string): void;
  close(): void;
}

export class StdioTransport implements Transport {
  private closed = false;
  private readonly output: Writable;

  constructor(
    input: Readable,
    output: Writable,
    onLine: (line: string) => void,
  ) {
    this.output = output;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!this.closed) onLine(line);
    });
  }

  write(line: string): void {
    if (this.closed) return;
    this.output.write(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.end();
  }
}

export interface LinkedEnd extends Transport {
  onLine: (line: string) => void;
  other: LinkedEnd | null;
}

/** A pair of in-memory transports wired to each other, for tests and embedding. */
export function createTransportPair(): [LinkedEnd, LinkedEnd] {
  const a: LinkedEnd = {
    onLine: () => {},
    other: null,
    write(line) {
      const target = this.other;
      if (target) queueMicrotask(() => target.onLine(line));
    },
    close() {
      if (this.other) this.other.other = null;
      this.other = null;
    },
  };
  const b: LinkedEnd = {
    onLine: () => {},
    other: null,
    write(line) {
      const target = this.other;
      if (target) queueMicrotask(() => target.onLine(line));
    },
    close() {
      if (this.other) this.other.other = null;
      this.other = null;
    },
  };
  a.other = b;
  b.other = a;
  return [a, b];
}

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
};

export type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

export class Peer extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();
  private requestHandler: RequestHandler | null = null;

  constructor(private readonly transport: Transport) {
    super();
  }

  /** Wire line input into this peer (called by the transport's onLine). */
  handleLine(line: string): void {
    let msg: JsonRpcMessage | null;
    try {
      msg = decodeLine(line);
      if (msg === null) return;
    } catch (err) {
      const rpcErr = err instanceof RpcError ? err : new RpcError(RpcErrorCode.ParseError, 'Parse error');
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: rpcErr.code, message: rpcErr.message },
      });
      return;
    }

    if (isResponse(msg)) {
      if (msg.id === null) return; // error responses to unparseable input
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if ('error' in msg) {
        entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (isRequest(msg)) {
      void this.dispatchRequest(msg);
      return;
    }

    this.emit('notification', msg.method, msg.params);
  }

  setRequestHandler(handler: RequestHandler | null): void {
    this.requestHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        timer: timeoutMs
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError(RpcErrorCode.Timeout, `Request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null,
      };
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private async dispatchRequest(msg: JsonRpcRequest): Promise<void> {
    if (!this.requestHandler) {
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: RpcErrorCode.MethodNotFound, message: `No handler: ${msg.method}` },
      });
      return;
    }
    try {
      const result = await this.requestHandler(msg.method, msg.params);
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (err) {
      const rpcErr =
        err instanceof RpcError
          ? err
          : new RpcError(RpcErrorCode.InternalError, err instanceof Error ? err.message : String(err));
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: rpcErr.code, message: rpcErr.message, data: rpcErr.data },
      });
    }
  }

  private send(m: JsonRpcMessage): void {
    try {
      this.transport.write(encodeMessage(m));
    } catch (err) {
      this.failAllPending(err);
    }
  }

  private failAllPending(err: unknown): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.pending.clear();
  }

  close(): void {
    this.failAllPending(new RpcError(RpcErrorCode.Cancelled, 'Connection closed'));
    this.transport.close();
  }
}

/** Peer wired to this process's stdin/stdout. */
export function createStdioPeer(): Peer {
  const peer = new Peer(
    new StdioTransport(process.stdin, process.stdout, (line) => peer.handleLine(line)),
  );
  return peer;
}

/** Two peers wired to each other over an in-memory transport (tests/embedding). */
export function createPeerPair(): [Peer, Peer] {
  const [ta, tb] = createTransportPair();
  const a = new Peer(ta);
  const b = new Peer(tb);
  ta.onLine = (line) => a.handleLine(line);
  tb.onLine = (line) => b.handleLine(line);
  return [a, b];
}
