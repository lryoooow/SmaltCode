import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  decodeLine,
  encodeMessage,
  isNotification,
  isRequest,
  isResponse,
  RpcError,
} from '../src/protocol/rpc.js';
import { Peer, createPeerPair } from '../src/protocol/connection.js';

describe('json-rpc codec', () => {
  it('round-trips requests, notifications and responses', () => {
    const req = encodeMessage({ jsonrpc: '2.0', id: 3, method: 'turn/start', params: { a: 1 } });
    expect(isRequest(decodeLine(req)!)).toBe(true);

    const notif = encodeMessage({ jsonrpc: '2.0', method: 'item/started' });
    expect(isNotification(decodeLine(notif)!)).toBe(true);

    const res = encodeMessage({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    const parsed = decodeLine(res)!;
    expect(isResponse(parsed)).toBe(true);
  });

  it('returns null for blank lines', () => {
    expect(decodeLine('')).toBeNull();
    expect(decodeLine('   ')).toBeNull();
  });

  it('throws RpcError on malformed json', () => {
    expect(() => decodeLine('{oops')).toThrow(RpcError);
  });

  it('throws on invalid envelopes', () => {
    expect(() => decodeLine('{"jsonrpc":"1.0","method":"x"}')).toThrow(RpcError);
    expect(() => decodeLine('{"jsonrpc":"2.0"}')).toThrow(RpcError);
  });

  it('parses error responses with null id', () => {
    const m = decodeLine('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse"}}')!;
    expect(isResponse(m)).toBe(true);
  });
});

describe('Peer over in-memory transport', () => {
  it('serves requests and returns results', async () => {
    const [server, client] = createPeerPair();

    server.setRequestHandler((method, params) => {
      if (method === 'echo') return params;
      throw new RpcError(-32601, `no such method ${method}`);
    });

    const result = await client.request('echo', { hello: 'world' });
    expect(result).toEqual({ hello: 'world' });

    await expect(client.request('nope')).rejects.toThrow(/no such method/);
    server.close();
    client.close();
  });

  it('delivers notifications', async () => {
    const [server, client] = createPeerPair();

    const seen = new Promise<string>((resolve) => {
      client.on('notification', (method: string) => resolve(method));
    });
    server.notify('item/agentMessage/delta', { delta: 'hi' });
    expect(await seen).toBe('item/agentMessage/delta');
    server.close();
    client.close();
  });

  it('supports reverse requests (kernel → client approval)', async () => {
    const [server, client] = createPeerPair();

    client.setRequestHandler(async (method, params) => {
      if (method === 'item/requestApproval') {
        return { decision: 'allow', remember: 'session' };
      }
      return null;
    });

    const decision = await server.request('item/requestApproval', { tool: 'shell', title: 'npm test' });
    expect(decision).toEqual({ decision: 'allow', remember: 'session' });
    server.close();
    client.close();
  });

  it('rejects pending requests on close', async () => {
    const [server, client] = createPeerPair();
    server.setRequestHandler(() => new Promise(() => {})); // never answers

    const pending = client.request('hang');
    client.close();
    await expect(pending).rejects.toThrow(/closed/i);
    server.close();
  });
});
