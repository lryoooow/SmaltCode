import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelGateway } from '../src/models/gateway.js';
import { ModelCatalog } from '../src/models/catalog.js';
import type { Settings } from '../src/config/settings.js';
import type { ChatMessage } from '../src/models/types.js';
let gateway: ModelGateway;
beforeEach(async () => {
  const cfg = { baseUrl: 'https://fixture.example/v1', wire: 'chat' as const, apiKey: 'fixture' };
  const catalog = new ModelCatalog({ fetchImpl: (async () => new Response(JSON.stringify({ data: [
    { id: 'text', input_modalities: ['text'], supported_parameters: ['tools'] },
    { id: 'vision', input_modalities: ['text', 'image'], supported_parameters: ['tools'] },
    { id: 'no-tools', supports_tools: false }, { id: 'retired', lifecycle: 'retired' }, { id: 'unknown' },
  ] }))) as typeof fetch });
  await catalog.refresh(cfg); gateway = new ModelGateway({ providers: { test: cfg } } as unknown as Settings, { catalog });
});
afterEach(() => vi.unstubAllGlobals());
const images: ChatMessage[] = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }] }];
it('blocks known text-only image/history requests before any generation request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const run = async () => { for await (const _ of gateway.stream({ provider: 'test', model: 'text' }, { messages: [...images, { role: 'user', content: '继续' }], tools: [] })) {} };
  await expect(run()).rejects.toThrow('历史图片'); expect(fetch).not.toHaveBeenCalled();
});
it('allows text on text models, vision on vision models and unknown metadata without guessing', () => {
  expect(() => gateway.validateRequest({ provider: 'test', model: 'text' }, { messages: [{ role: 'user', content: '文字' }], tools: [] })).not.toThrow();
  for (const model of ['vision', 'unknown', 'custom-id']) expect(() => gateway.validateRequest({ provider: 'test', model }, { messages: images, tools: [] })).not.toThrow();
});
it('checks tool support independently of image capability and blocks retired models even for summaries', () => {
  expect(() => gateway.validateRequest({ provider: 'test', model: 'no-tools' }, { messages: [], tools: [{ name: 'read', description: '', inputSchema: {} }] })).toThrow('不支持');
  expect(() => gateway.validateRequest({ provider: 'test', model: 'retired' }, { messages: [], tools: [] })).toThrow('下线');
});
