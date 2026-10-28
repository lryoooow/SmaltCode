import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, updateUserSettingsFile } from '../src/config/settings.js';
import { ModelGateway } from '../src/models/gateway.js';
import { resolveContextWindow } from '../src/models/context-window.js';
import { Kernel } from '../src/core/kernel.js';

let dir: string, previous: string | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smalt-window-')); previous = process.env.SMALT_HOME; process.env.SMALT_HOME = join(dir, 'home'); mkdirSync(process.env.SMALT_HOME); });
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
it('resolves official models by endpoint and exact model, including the Anthropic route', () => {
  const cfg = loadSettings(dir).providers.deepseek!;
  for (const model of ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) expect(resolveContextWindow(cfg, model)).toEqual({ tokens: 1_048_576, source: 'official' });
  expect(resolveContextWindow({ ...cfg, baseUrl: 'https://api.deepseek.com/anthropic', wire: 'anthropic' }, 'deepseek-v4-pro').tokens).toBe(1_048_576);
  for (const baseUrl of ['https://proxy.example/v1', 'https://api.deepseek.com.attacker.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com/custom', 'https://api.deepseek.com/v1?route=x']) expect(resolveContextWindow({ ...cfg, baseUrl }, 'deepseek-v4-pro').source).toBe('fallback');
  expect(resolveContextWindow(cfg, 'deepseek-unknown').tokens).toBe(128_000);
});
it('honors explicit provider and model limits, restores automatic resolution, and ignores invalid limits', () => {
  let settings = updateUserSettingsFile(dir, { providers: { deepseek: { contextWindow: 64_000, modelContextWindows: { 'deepseek-v4-pro': 256_000 } } } });
  let gateway = new ModelGateway(settings);
  expect(gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(256_000);
  expect(gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-flash' })).toBe(64_000);
  settings = updateUserSettingsFile(dir, { providers: { deepseek: { contextWindow: null, modelContextWindows: { 'deepseek-v4-pro': null, other: -5 } } } });
  gateway = new ModelGateway(settings);
  expect(gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(1_048_576);
  expect(settings.providers.deepseek?.modelContextWindows?.other).toBeUndefined();
  expect(resolveContextWindow({ ...settings.providers.deepseek!, contextWindow: Infinity }, 'deepseek-v4-pro').tokens).toBe(1_048_576);
});
it('runs a 100K-token conversation on V4 without compaction, and reports the same window after reopening', async () => {
  writeFileSync(join(process.env.SMALT_HOME!, 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' }));
  const events: any[] = [];
  const k = new Kernel({ cwd: dir, client: { notify: (method, params) => events.push({ method, params }), requestApproval: async () => ({ decision: 'deny' }), askUser: async () => '' } });
  const requests: any[] = [];
  vi.spyOn(k.gateway, 'fork').mockReturnValue(k.gateway);
  vi.spyOn(k.gateway, 'stream').mockImplementation(async function* (_ref, req) { requests.push(req); yield { type: 'text', text: '只检查，内容已核对。' }; yield { type: 'done', finishReason: 'stop' }; });
  const { threadId } = await k.handle('thread/start', { cwd: dir }) as any;
  const rt = k.threads.require(threadId);
  rt.history.push(...Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'history '.repeat(2500) })));
  expect(await k.handle('turn/start', { threadId, input: '只检查，不修改文件。' })).toMatchObject({ failed: false });
  expect(requests).toHaveLength(1);
  expect(events.some(e => e.method === 'thread/compacted' || e.method === 'thread/context/notice')).toBe(false);
  expect(events.find(e => e.method === 'thread/tokenUsage/updated')?.params.usage ?? events.find(e => e.params?.usage?.contextWindow)?.params.usage).toMatchObject({ contextWindow: 1_048_576, thresholdTokens: 838_860 });
  expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 1_048_576, thresholdTokens: 838_860 } });
  await k.handle('thread/archive', { threadId }); await k.handle('thread/restore', { threadId });
  expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 1_048_576, thresholdTokens: 838_860 } });
});
it('keeps the running request budget stable when settings change and adopts the new model budget next turn', async () => {
  writeFileSync(join(process.env.SMALT_HOME!, 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' }));
  const k = new Kernel({ cwd: dir, client: { notify() {}, requestApproval: async () => ({ decision: 'deny' }), askUser: async () => '' } });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
  vi.spyOn(k.gateway, 'fork').mockReturnValue(k.gateway);
  vi.spyOn(k.gateway, 'stream').mockImplementation(async function* () { started(); await gate; yield { type: 'text', text: 'Checked.' }; yield { type: 'done', finishReason: 'stop' }; });
  const { threadId } = await k.handle('thread/start', { cwd: dir }) as any;
  const running = k.handle('turn/start', { threadId, input: '只检查。' });
  await ready;
  const settings = structuredClone(k.getSettings()); settings.providers.deepseek!.modelContextWindows = { 'deepseek-v4-pro': 256000 }; k.applySettings(settings);
  expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 1048576, thresholdTokens: 838860 } });
  release(); await running;
  await k.handle('turn/start', { threadId, input: '继续检查。' });
  expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 256000, thresholdTokens: 204800 } });
});
it('uses discovered capacity before compaction and recalculates it when switching models in the same conversation', async () => {
  const settings = loadSettings(dir); settings.providers.test = { baseUrl: 'https://models.example/v1', wire: 'chat', apiKey: 'fixture' }; settings.defaultProvider = 'test'; settings.defaultModel = 'long'; settings.compact.keepMessages = 2;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'long', context_window: 1000000 }, { id: 'small', context_window: 32000 }] }))));
  try {
    const notices: any[] = [];
    const k = new Kernel({ cwd: dir, settings, modelDiscovery: true, client: { notify: (method, params) => notices.push({ method, params }), requestApproval: async () => ({ decision: 'deny' }), askUser: async () => '' } });
    vi.spyOn(k.gateway, 'fork').mockReturnValue(k.gateway);
    let summaries = 0;
    vi.spyOn(k.gateway, 'stream').mockImplementation(async function* (_ref, req) { if (!req.tools.length) summaries++; yield { type: 'text', text: req.tools.length ? '只检查，已核对。' : '任务与约束已保留，继续检查。' }; yield { type: 'done', finishReason: 'stop' }; });
    const { threadId } = await k.handle('thread/start', { cwd: dir }) as any;
    k.threads.require(threadId).history.push(...Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'history '.repeat(2500) })));
    expect(await k.handle('turn/start', { threadId, input: '只检查。' })).toMatchObject({ failed: false });
    expect(summaries).toBe(0); expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 1000000 } });
    await k.handle('thread/settings/update', { threadId, model: 'test/small' });
    expect(await k.handle('turn/start', { threadId, input: '继续只检查。' })).toMatchObject({ failed: false });
    expect(summaries).toBe(1); expect(await k.handle('thread/read', { threadId })).toMatchObject({ usage: { contextWindow: 32000, thresholdTokens: 25600 } });
    expect(notices.find(e => e.method === 'thread/context/notice')?.params.notice.contextWindow).toBe(32000);
  } finally { vi.unstubAllGlobals(); }
});
