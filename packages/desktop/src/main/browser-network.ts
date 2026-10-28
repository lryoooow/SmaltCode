import { lookup } from 'node:dns/promises';
import { request as https } from 'node:https';
import { request as http } from 'node:http';
import { publicAddress } from './safe-download.js';
import { browserRequestAllowed, browserCSP } from './browser-policy.js';

/** Read-only browser transport, pinned to validated DNS. No OS/browser ambient cookies. */
export async function browserFetch(request: Request, origin: string, sources: string[] = []): Promise<Response> {
  if (!browserRequestAllowed(request.url, origin) || !['GET', 'HEAD'].includes(request.method)) return new Response('此预览仅允许已授权站点的 GET / HEAD 请求', { status: 403 });
  const url = new URL(request.url), host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const addresses = local ? [{ address: host === 'localhost' ? '127.0.0.1' : host, family: host === '::1' ? 6 : 4 }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || !local && addresses.some(value => !publicAddress(value.address))) throw new Error('网页解析到了私网或保留地址，已阻止访问');
  const pinned = addresses[0]!;
  const headers: Record<string, string> = { accept: request.headers.get('accept') ?? '*/*', 'accept-encoding': 'identity', 'user-agent': 'SmaltCode-Preview/0.0.4' };
  // Chromium owns this forbidden request header. Preserve it for development
  // servers that return a specific Access-Control-Allow-Origin, without cookies.
  const pageOrigin = request.headers.get('origin');
  if (pageOrigin && pageOrigin.length <= 1024 && !/[\x00-\x20\x7f]/.test(pageOrigin)) headers.origin = pageOrigin;
  return new Promise((resolve, reject) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    const done = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
    const req = (url.protocol === 'https:' ? https : http)(url, { method: request.method, signal: controller.signal, headers, family: pinned.family, lookup: ((_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, pinned.address, pinned.family)) as never }, res => {
      const chunks: Buffer[] = []; let total = 0;
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(new Error('站点返回了不支持的压缩响应')); }
      res.on('data', (bytes: Buffer) => { total += bytes.length; if (total > 8 * 1024 * 1024) res.destroy(new Error('网页资源超过 8 MB')); else chunks.push(bytes); });
      res.on('error', error => { done(); reject(error); });
      res.on('end', () => {
        done();
        const headers = new Headers();
        for (const key of ['content-type', 'location', 'cache-control', 'etag', 'last-modified', 'content-disposition', 'access-control-allow-origin', 'access-control-expose-headers']) { const value = res.headers[key]; if (typeof value === 'string') headers.set(key, value); }
        // A page cannot relax this policy with its own meta tag. No frames, workers,
        // uploads, downloads, remote websocket or form submission in review mode.
        headers.set('Content-Security-Policy', browserCSP(sources));
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), bluetooth=()');
        const status = res.statusCode ?? 502;
        resolve(new Response(request.method === 'HEAD' || [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)).buffer, { status, headers }));
      });
    });
    req.on('error', error => { done(); reject(error); }); req.end();
  });
}
