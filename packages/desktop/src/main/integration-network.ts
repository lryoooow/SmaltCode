import { lookup } from 'node:dns/promises';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { publicAddress } from './safe-download.js';
import { integrationURL } from './integration-policy.js';

/** Credential-bearing requests never follow redirects. DNS is pinned for every connection. */
export function integrationFetch(allow: (url: URL, request: Request) => Promise<void>, maximum = 2 * 1024 * 1024) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init), url = integrationURL(request.url);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new Error('连接器请求方法不支持');
    await allow(url, request);
    if (request.signal.aborted) throw new Error('连接器操作已取消');
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.length > 256 * 1024) throw new Error('连接器请求超过 256 KB');
    const host = url.hostname.replace(/^\[|\]$/g, ''), local = ['localhost', '127.0.0.1', '::1'].includes(host);
    const addresses = local ? [{ address: host === 'localhost' ? '127.0.0.1' : host, family: host === '::1' ? 6 : 4 }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || !local && addresses.some(value => !publicAddress(value.address))) throw new Error('连接器地址解析到私网或保留地址，已拒绝连接');
    if (request.signal.aborted) throw new Error('连接器操作已取消');
    const pinned = addresses[0]!;
    const headers = Object.fromEntries([...request.headers].filter(([key]) => !['host', 'cookie', 'referer', 'proxy-authorization', 'connection', 'content-length', 'accept-encoding'].includes(key)));
    headers['accept-encoding'] = 'identity'; if (body) headers['content-length'] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 65_000);
      const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
      const done = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
      const req = (url.protocol === 'https:' ? https : http)(url, { method: request.method, headers, signal: controller.signal, family: pinned.family, lookup: ((_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as never }, res => {
        let bytes = 0;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) { res.resume(); done(); reject(new Error('连接器发生重定向，已停止；请核对并修改服务地址后重新认证')); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.resume(); done(); reject(new Error('连接器返回了不支持的压缩响应')); return; }
        const status = res.statusCode ?? 502, outgoing = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string' && !['set-cookie', 'content-length', 'transfer-encoding', 'content-encoding'].includes(key)) outgoing.set(key, value);
        if ([204, 205, 304].includes(status)) { res.resume(); done(); resolve(new Response(null, { status, headers: outgoing })); return; }
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            res.on('data', (chunk: Buffer) => { if (closed) return; bytes += chunk.length; if (bytes > maximum) { res.destroy(new Error('连接器响应超过读取上限')); return; } streamController.enqueue(new Uint8Array(chunk)); if ((streamController.desiredSize ?? 0) <= 0) res.pause(); });
            res.on('error', error => { done(); if (!closed) { closed = true; streamController.error(error); } });
            res.on('end', () => { done(); if (!closed) { closed = true; streamController.close(); } });
          },
          pull() { res.resume(); },
          cancel() { closed = true; done(); res.destroy(); req.destroy(); },
        });
        resolve(new Response(stream, { status, headers: outgoing }));
      });
      req.on('error', error => { done(); reject(error); }); if (body) req.write(body); req.end();
    });
  };
}
