import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelCatalog, parseModel, modelCardLimits, parseOfficialCatalog } from '../src/models/catalog.js';
import { ModelGateway } from '../src/models/gateway.js';
import { resolveContextWindow } from '../src/models/context-window.js';
import { loadSettings, type ProviderConfig } from '../src/config/settings.js';
import { officialModels } from '../src/models/profiles.js';

let dir: string, previous: string | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smalt-catalog-')); previous = process.env.SMALT_HOME; process.env.SMALT_HOME = dir; });
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previous; rmSync(dir, { force: true, recursive: true }); });
const cfg: ProviderConfig = { baseUrl: 'https://proxy.example/v1', wire: 'chat', apiKey: 'test-secret' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('endpoint-specific model discovery', () => {
  it('syncs exact names from official catalogs when a vendor has no models endpoint, without forwarding credentials', async () => {
    const config: ProviderConfig = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wire: 'chat', apiKey: 'fixture-secret' };
    const calls: string[] = [];
    const catalog = new ModelCatalog({ fetchImpl: (async (url, req) => {
      calls.push(String(url)); if (calls.length === 1) return response({}, 404);
      expect(String(url)).toBe('https://docs.bigmodel.cn/cn/guide/start/model-overview.md'); expect(req?.headers).not.toHaveProperty('authorization');
      return new Response('| 模型 | 特点 | 上下文 | 最大输出 |\n|---|---|---|---|\n| GLM-NEW | 当前新模型 | 2M | 128K |');
    }) as typeof fetch });
    const data = await catalog.refresh(config); expect(data).toMatchObject({ source: 'official', models: [{ id: 'glm-new', contextWindow: 2000000 }] });
    await catalog.refresh(config); expect(calls).toHaveLength(2);
    expect(parseOfficialCatalog('| 模型名称 | 描述 |\n|---|---|\n| `kimi-new` | 100万 token 上下文窗口 |\n## 已下线模型\n| 模型 | 描述 |\n|---|---|\n| `kimi-old` | 已下线 |', { ...config, baseUrl: 'https://api.moonshot.cn/v1' }, 'official')).toMatchObject([{ id: 'kimi-new', contextWindow: 1000000 }, { id: 'kimi-old', lifecycle: 'retired' }]);
    expect(parseOfficialCatalog('<table><tr><th>Model ID</th><th>Context</th><th>Max output</th><th>Function calling</th></tr><tr><td>qwen-next</td><td>1M</td><td>64K</td><td>Supported</td></tr><tr><td>qwen-no-tools</td><td>256K</td><td>32K</td><td>Unsupported</td></tr></table><script>qwen-bad 99M</script>', { ...config, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, 'official')).toMatchObject([{ id: 'qwen-next', contextWindow: 1000000, tools: true }, { id: 'qwen-no-tools', contextWindow: 256000, tools: false, unavailableReason: expect.stringContaining('不支持工具调用') }]);
  });
  it('discovers new names, windows and capabilities without ever sending a prompt; forks share metadata', async () => {
    const fetchImpl = vi.fn(async (_url, request) => { expect(request?.method).toBe('GET'); expect(request?.body).toBeUndefined(); expect(request?.redirect).toBe('error'); return response({ data: [{ id: 'brand-new-model', name: '新模型', context_window: 1_000_000, max_output_tokens: 128_000, input_modalities: ['text', 'image'], supported_parameters: ['tools'] }] }); }) as typeof fetch;
    const catalog = new ModelCatalog({ fetchImpl }); const settings = loadSettings(dir); settings.providers.test = cfg;
    const gateway = new ModelGateway(settings, { automaticDiscovery: true, catalog });
    expect(gateway.contextWindowFor({ provider: 'test', model: 'brand-new-model' })).toBe(128000);
    expect(await gateway.prepare({ provider: 'test', model: 'brand-new-model' })).toBe(1000000);
    expect(gateway.modelsFor('test').models[0]).toMatchObject({ name: '新模型', vision: true, tools: true });
    expect(gateway.fork(settings).contextWindowFor({ provider: 'test', model: 'brand-new-model' })).toBe(1000000);
    await gateway.prepare({ provider: 'test', model: 'brand-new-model' }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('isolates caches by endpoint, account and protocol and persists only sanitized metadata', async () => {
    const file = join(dir, 'cache.json'), fetchImpl = vi.fn(async () => response({ data: [{ id: 'test', context_length: 256000, raw_secret: 'NEVER_SAVE', description: 'do not persist arbitrary fields' }] })) as typeof fetch;
    const catalog = new ModelCatalog({ file, fetchImpl }); await catalog.refresh(cfg);
    expect(new ModelCatalog({ file }).snapshot(cfg).models[0]?.contextWindow).toBe(256000);
    for (const changed of [{ ...cfg, baseUrl: 'https://other.example/v1' }, { ...cfg, apiKey: 'other-key' }, { ...cfg, wire: 'anthropic' as const }]) expect(catalog.snapshot(changed).models).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/test-secret|NEVER_SAVE|description|proxy\.example/);
  });
  it('will not send existing credentials after an endpoint change and never follows redirects', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('transport failed with test-secret'); }) as typeof fetch;
    const catalog = new ModelCatalog({ fetchImpl });
    expect((await catalog.refresh({ ...cfg, apiKeyEndpoint: 'https://other.example/v1' })).error).toContain('地址已变化');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await catalog.refresh(cfg)).error).not.toContain('test-secret');
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
  });
  it('coalesces simultaneous refreshes and refreshes stale values while retaining cache on outage', async () => {
    let now = 0, offline = false;
    const fetchImpl = vi.fn(async () => { if (offline) throw new Error('offline'); return response({ data: [{ id: 'm', context_window: 512000 }] }); }) as typeof fetch;
    const catalog = new ModelCatalog({ fetchImpl, now: () => now });
    await Promise.all([catalog.refresh(cfg), catalog.refresh(cfg), catalog.refresh(cfg, true)]); expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 7 * 60 * 60 * 1000; offline = true;
    expect(await catalog.refresh(cfg)).toMatchObject({ stale: true, source: 'api', models: [{ id: 'm', contextWindow: 512000 }], error: expect.stringContaining('获取失败') });
    await catalog.refresh(cfg); expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 8 * 24 * 60 * 60 * 1000; expect(catalog.snapshot(cfg).models).toEqual([]);
  });
  it('parses Anthropic input limits and cursor pagination without treating output budget as context', async () => {
    const calls: string[] = [], anthropic: ProviderConfig = { baseUrl: 'https://api.anthropic.com', wire: 'anthropic', apiKey: 'test' };
    const catalog = new ModelCatalog({ fetchImpl: (async (url, options) => {
      calls.push(String(url)); expect(options?.headers).toMatchObject({ 'x-api-key': 'test', 'anthropic-version': '2023-06-01' });
      return response(calls.length === 1 ? { data: [{ id: 'a', max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'a' } : { data: [{ id: 'b', max_input_tokens: 200000, max_tokens: 128000 }], has_more: false });
    }) as typeof fetch });
    const data = await catalog.refresh(anthropic); expect(data.models).toHaveLength(2);
    expect(resolveContextWindow(anthropic, 'a', data.models.find(m => m.id === 'a')).tokens).toBe(1000000);
    expect(calls[0]).toContain('/v1/models?limit=1000'); expect(calls[1]).toContain('after_id=a');
  });
  it('uses lower routing/input limits and excludes retired and non-agent models', () => {
    const info = parseModel({ id: 'a', context_length: 1000000, top_provider: { context_length: 256000, max_completion_tokens: 64000 }, max_input_tokens: 200000, supported_parameters: ['tools'] }, cfg)!;
    expect(info.contextWindow).toBe(256000); expect(resolveContextWindow(cfg, 'a', info).tokens).toBe(200000);
    expect(parseModel({ id: 'text-embedding-3-small' }, cfg)?.unavailableReason).toContain('不支持');
    expect(parseModel({ id: 'a', lifecycle: 'retired' }, cfg)?.unavailableReason).toContain('下线');
    expect(parseModel({ id: 'a', context_window: -1, max_tokens: 64000 }, cfg)?.contextWindow).toBeUndefined();
    expect(parseModel({ id: 'bad\nname', context_window: 1000000 }, cfg)).toBeUndefined();
  });
  it('requests OpenRouter account-filtered models and DeepSeek metadata with the correct authentication route', async () => {
    for (const [config, path] of [[{ baseUrl: 'https://openrouter.ai/api/v1', wire: 'chat', apiKey: 'test' }, '/api/v1/models/user'], [{ baseUrl: 'https://api.deepseek.com/anthropic', wire: 'anthropic', apiKey: 'test' }, '/models']] as const) {
      const catalog = new ModelCatalog({ fetchImpl: (async (url, options) => { expect(new URL(String(url)).pathname).toBe(path); expect(options?.headers).toMatchObject({ authorization: 'Bearer test' }); return response({ data: [] }); }) as typeof fetch });
      expect((await catalog.refresh(config)).error).toBeUndefined();
    }
  });
  it('reads Ollama active allocation or explicit num_ctx, never the theoretical model maximum', async () => {
    const local: ProviderConfig = { baseUrl: 'http://localhost:11434/v1', wire: 'chat', apiKey: 'ollama' };
    const fetchImpl = vi.fn(async (url, request) => { const path = new URL(String(url)).pathname; expect(request?.headers).not.toHaveProperty('authorization');
      return response(path === '/api/tags' ? { models: [{ name: 'local:8b' }, { name: 'cold:8b' }] } : path === '/api/ps' ? { models: [{ name: 'local:8b', context_length: 8192 }] } : { parameters: 'temperature 0.5\nnum_ctx 16384', model_info: { 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] });
    }) as typeof fetch;
    const catalog = new ModelCatalog({ fetchImpl }); let data = await catalog.refresh(local, true, 'cold:8b');
    expect(data.models.find(m => m.id === 'local:8b')?.contextWindow).toBe(8192); expect(data.models.find(m => m.id === 'cold:8b')?.contextWindow).toBe(16384);
    expect(resolveContextWindow(local, 'unloaded').tokens).toBe(4096);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('falls back on 401/404/invalid/oversized data and handles broken cache files', async () => {
    for (const res of [response({}, 401), response({}, 404), response({ data: 'bad' }), new Response('x'.repeat(4 * 1024 * 1024 + 1))]) {
      const catalog = new ModelCatalog({ fetchImpl: (async () => res) as typeof fetch }); expect((await catalog.refresh(cfg)).error).toBeTruthy();
    }
    const file = join(dir, 'bad.json'); writeFileSync(file, '{'); expect(new ModelCatalog({ file }).snapshot(cfg).models).toEqual([]);
  });
  it('checks each official provider per model rather than applying a provider-wide constant', () => {
    const settings = loadSettings(dir);
    for (const [provider, id, tokens] of [['openai', 'gpt-4.1', 1047576], ['openai', 'gpt-6.1-sol', 922000], ['anthropic', 'claude-sonnet-5-5', 1000000], ['deepseek', 'deepseek-v4-pro', 1000000], ['zhipu', 'glm-4.6', 200000], ['zhipu', 'glm-5.3', 1000000], ['moonshot', 'kimi-k3', 1000000], ['moonshot', 'kimi-k2.6', 256000], ['dashscope', 'qwen3-coder-plus', 1000000]] as const) expect(resolveContextWindow(settings.providers[provider]!, id).tokens).toBe(tokens);
    expect(officialModels(settings.providers.moonshot!).find(m => m.id === 'kimi-k2-0905-preview')?.lifecycle).toBe('retired');
    expect(officialModels({ ...settings.providers.zhipu!, baseUrl: 'https://proxy.example/v1' })).toEqual([]);
  });
  it('enriches new public OpenAI names from bounded official model cards without sending API credentials', async () => {
    const config: ProviderConfig = { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-secret', wire: 'chat' };
    const calls: string[] = [];
    const catalog = new ModelCatalog({ fetchImpl: (async (url, req) => {
      calls.push(String(url));
      if (calls.length === 1) return response({ data: [{ id: 'gpt-future', owned_by: 'openai' }, { id: 'gpt-private-name', owned_by: 'customer' }, { id: 'ft:tenant-secret', owned_by: 'openai' }] });
      expect(String(url)).toBe('https://developers.openai.com/api/docs/models/gpt-future.md');
      expect(req?.headers).not.toHaveProperty('authorization'); expect(req?.headers).not.toHaveProperty('x-api-key');
      return new Response('# Future\n- Context window: 2,000,000 tokens\n- Max input: 1,800,000 tokens\n- Max output: 200,000 tokens');
    }) as typeof fetch });
    await catalog.refresh(config); await catalog.enrich(config, 'gpt-future'); await catalog.enrich(config, 'gpt-future'); await catalog.enrich(config, 'gpt-private-name'); await catalog.enrich(config, 'ft:tenant-secret');
    expect(calls).toHaveLength(2); const info = catalog.snapshot(config).models.find(m => m.id === 'gpt-future');
    expect(info).toMatchObject({ source: 'official', contextWindow: 2000000, maxInputTokens: 1800000 });
    expect(resolveContextWindow(config, 'gpt-future', info).tokens).toBe(1800000);
    expect(modelCardLimits('Context window: 1.05M tokens\nMax output: 128K tokens')).toMatchObject({ contextWindow: 1050000, maxOutputTokens: 128000 });
    expect(modelCardLimits('Tokens Per Minute: 2000000')).toMatchObject({ contextWindow: undefined });
  });
  it('does not replace a service-reported capacity with a larger theoretical public spec', async () => {
    const config: ProviderConfig = { baseUrl: 'https://api.openai.com/v1', wire: 'chat', apiKey: 'fixture' };
    const fetchImpl = vi.fn(async () => response({ data: [{ id: 'gpt-future', owned_by: 'openai', context_window: 256000 }] })) as typeof fetch;
    const catalog = new ModelCatalog({ fetchImpl }); await catalog.refresh(config); await catalog.enrich(config, 'gpt-future'); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(catalog.snapshot(config).models[0]?.contextWindow).toBe(256000);
  });
  it('cancels preparation promptly while a shared metadata request remains bounded and usable by other tasks', async () => {
    let release!: (value: Response) => void;
    const catalog = new ModelCatalog({ fetchImpl: (() => new Promise<Response>(r => { release = r; })) as typeof fetch });
    const settings = loadSettings(dir); settings.providers.test = cfg;
    const gateway = new ModelGateway(settings, { automaticDiscovery: true, catalog }); const controller = new AbortController();
    const prepared = gateway.prepare({ provider: 'test', model: 'm' }, controller.signal); controller.abort();
    await expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    release(response({ data: [{ id: 'm', context_window: 512000 }] }));
    expect(await gateway.prepare({ provider: 'test', model: 'm' })).toBe(512000);
  });
});
