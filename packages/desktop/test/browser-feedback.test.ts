import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { browserURL, browserRequestAllowed, localPreviewAsset, imageRegion, browserCSP } from '../src/main/browser-policy';
import { browserFetch } from '../src/main/browser-network';
import { FeedbackStore } from '../src/main/feedback';
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'smalt-browser-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('browser and explicit feedback boundaries', () => {
  it('builds page policy from validated exact origins while keeping frames, workers and forms denied', () => {
    const csp = browserCSP(['https://cdn.example.com/assets', 'http://127.0.0.1:8080']);
    expect(csp).toContain('https://cdn.example.com'); expect(csp).not.toContain('/assets'); expect(csp).toContain("frame-src 'none'"); expect(csp).toContain("form-action 'none'");
    expect(() => browserCSP(['http://10.0.0.1'])).toThrow();
  });
  it('accepts only explicit secure public or literal loopback development locations', () => {
    for (const url of ['https://example.com/a', 'http://localhost:5173/', 'http://127.0.0.1:3000', 'http://[::1]:8080']) expect(browserURL(url).href).toBeTruthy();
    for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'https://user:secret@example.com', 'http://example.com', 'https://10.0.0.1', 'https://[fe80::1]', 'https://intranet.local', 'https://intranet', 'https://example.com/\n']) expect(() => browserURL(url)).toThrow();
  });
  it('never equates opaque origins, protocols, ports, credentials or lookalike hosts', () => {
    const origin = 'smalt-preview://web-one';
    expect(browserRequestAllowed(origin + '/index.html', origin)).toBe(true);
    for (const url of ['smalt-preview://web-two/data.json', 'file:///secret.txt', 'https://example.com']) expect(browserRequestAllowed(url, origin)).toBe(false);
    for (const url of ['https://example.com.evil.com', 'http://example.com', 'https://example.com:8443', 'https://user@example.com']) expect(browserRequestAllowed(url, 'https://example.com')).toBe(false);
  });
  it('serves only static assets in the explicitly selected directory', () => {
    const dir = join(root, 'page'); mkdirSync(dir); writeFileSync(join(dir, 'index.html'), '<p>page</p>'); writeFileSync(join(dir, '.env'), 'fixture');
    expect(localPreviewAsset(root, dir, '/index.html')).toMatchObject({ contentType: 'text/html', path: join(dir, 'index.html') });
    for (const path of ['/../secret.html', '/%2e%2e/secret.html', '/.env', '/%5csecret.html', '/C:/secret.html', '/secret.txt', '/%00.html', '/.git/config', '/foo/%2eenv']) expect(() => localPreviewAsset(root, dir, path)).toThrow();
  });
  it('validates finite normalized image regions and refuses degenerate/off-image selections', () => {
    expect(imageRegion({ x: .1, y: .2, width: .5, height: .4 })).toMatchObject({ x: .1 });
    for (const region of [null, {}, { x: 0, y: 0, width: Infinity, height: 1 }, { x: -.1, y: 0, width: 1, height: 1 }, { x: .5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) expect(() => imageRegion(region)).toThrow();
  });
  it('keeps immutable feedback scoped to its workspace and checks source versions at send', async () => {
    const store = new FeedbackStore(), ref = store.add({ cwd: root, label: '区域', source: 'chart.png', filePath: 'chart.png', fileDigest: 'v1', text: JSON.stringify({ note: '局部修改' }) });
    expect((await store.resolve(root, [ref], async () => 'v1')).text).toContain('不构成指令');
    await expect(store.read(join(root, 'another'), ref, async () => 'v1')).rejects.toThrow('工作区');
    await expect(store.read(root, { ...ref, digest: 'wrong' }, async () => 'v1')).rejects.toThrow('引用无效');
    await expect(store.read(root, ref, async () => 'v2')).rejects.toThrow('文件已变化');
    await expect(store.read(root, { ...ref, start: 0, end: 2 }, async () => 'v1')).rejects.toThrow('引用无效');
  });
  it('bounds snapshot memory and reports expired references rather than substituting other captures', async () => {
    const store = new FeedbackStore(); const first = store.add({ cwd: root, label: 'first', source: 'page', text: 'one' });
    for (let n = 0; n < 81; n++) store.add({ cwd: root, label: String(n), source: 'page', text: String(n) });
    await expect(store.read(root, first)).rejects.toThrow('过期');
    expect(() => store.add({ cwd: root, label: 'large', source: 'page', text: 'x'.repeat(24001) })).toThrow('过大');
  });
  it('makes real loopback GET requests with bounded read-only transport and no ambient authorization', async () => {
    const seen: string[] = [], server = createServer((req, res) => { seen.push(req.url!); expect(req.headers.cookie).toBeUndefined(); expect(req.headers.authorization).toBeUndefined(); expect(req.headers.origin).toBe('https://review.example.com'); res.setHeader('content-type', 'text/html'); res.end('<h1>development</h1>'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number }, origin = 'http://127.0.0.1:' + address.port;
    try {
      const result = await browserFetch(new Request(origin, { headers: { cookie: 'secret', authorization: 'Bearer secret', origin: 'https://review.example.com' } }), origin);
      expect(await result.text()).toContain('development'); expect(result.headers.get('content-security-policy')).toContain("form-action 'none'");
      expect((await browserFetch(new Request(origin, { method: 'POST', body: 'data' }), origin)).status).toBe(403);
      expect((await browserFetch(new Request('http://127.0.0.1:1'), origin)).status).toBe(403);
      expect(seen).toEqual(['/']);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rejects private or mixed DNS responses before creating a remote connection', async () => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], []]) {
      dns.lookup.mockResolvedValueOnce(addresses);
      await expect(browserFetch(new Request('https://private.test/'), 'https://private.test')).rejects.toThrow('私网');
    }
  });
  it('rejects oversized resource bodies without retaining an unbounded response', async () => {
    const server = createServer((_req, res) => { res.end(Buffer.alloc(8 * 1024 * 1024 + 1)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    try { await expect(browserFetch(new Request(origin), origin)).rejects.toThrow('8 MB'); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
