import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));
import { downloadSkill } from '../src/main/safe-download.js';

type Reply = { status?: number; headers?: Record<string, string>; body?: Buffer };
function replies(...values: Reply[]) {
  network.request.mockImplementation((_url, options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => queueMicrotask(() => {
      const value = values.shift()!;
      const response = Object.assign(new PassThrough(), { statusCode: value.status ?? 200, headers: value.headers ?? {} });
      callback(response); response.end(value.body ?? Buffer.from('skill body'));
    });
    return request;
  });
}
beforeEach(() => { vi.clearAllMocks(); network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); });
afterEach(() => vi.useRealTimers());

it('pins the checked address and discards credential-like query strings from saved origin', async () => {
  replies({ body: Buffer.from('中文技能') });
  expect(await downloadSkill('https://example.com/SKILL.md?token=secret')).toEqual({ text: '中文技能', origin: 'https://example.com/SKILL.md' });
  const options = network.request.mock.calls[0]![1];
  const callback = vi.fn(); options.lookup('example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  expect(options.headers.authorization).toBeUndefined(); expect(options.headers.cookie).toBeUndefined();
  expect(network.lookup).toHaveBeenCalledTimes(1);
});
it('rejects mixed public/private DNS responses before opening a connection', async () => {
  network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('私网');
  expect(network.request).not.toHaveBeenCalled();
});
it('rechecks redirect DNS and prevents public-to-private rebinding', async () => {
  replies({ status: 302, headers: { location: 'https://changed.example/SKILL.md' } });
  network.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('私网');
  expect(network.request).toHaveBeenCalledTimes(1);
});
it('limits redirects even when all destinations stay public', async () => {
  replies(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('重定向');
});
it('bounds streamed bytes without trusting Content-Length', async () => {
  replies({ body: Buffer.alloc(65537) });
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('64 KB');
});
it('rejects compressed and non-UTF8 responses', async () => {
  replies({ headers: { 'content-encoding': 'gzip' } });
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('未压缩');
  replies({ body: Buffer.from([0xff, 0xfe]) });
  await expect(downloadSkill('https://example.com/a')).rejects.toThrow('UTF-8');
});
it('times out even when DNS lookup never returns', async () => {
  vi.useFakeTimers(); network.lookup.mockReturnValue(new Promise(() => {}));
  const failure = expect(downloadSkill('https://example.com/a')).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(15001); await failure;
  expect(network.request).not.toHaveBeenCalled();
});
