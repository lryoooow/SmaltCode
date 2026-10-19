import { expect, it } from 'vitest';
import { modelChoices } from '../src/renderer/src/c/model-choices';
import type { SettingsData } from '../src/renderer/src/bridge';
it('preserves saved/custom model IDs, uses per-model limits and surfaces unsupported or unconfigured models', () => {
  const settings: SettingsData = { keyStorage: 'session', effective: { defaultProvider: 'test', defaultModel: 'custom', permissionMode: 'default' }, providers: { test: { baseUrl: 'https://models.example/v1', wire: 'chat', hasKey: true, modelContextWindows: { long: 256000 } }, other: { baseUrl: 'https://other.example/v1', wire: 'chat', hasKey: false, defaultModel: 'test' } }, catalogs: { test: { source: 'api', checkedAt: 1, stale: true, models: [{ id: 'long', name: '长模型', contextWindow: 1000000, source: 'api' }, { id: 'embed', name: '向量', source: 'api', tools: false, unavailableReason: '不支持工具' }] } } };
  const choices = modelChoices(settings, 'test/private/model');
  expect(choices.find(m => m.id === 'test/long')).toMatchObject({ window: 256000, source: '手动设置', stale: true });
  expect(choices.find(m => m.id === 'test/custom')?.source).toBe('容量待确认');
  expect(choices.find(m => m.id === 'test/private/model')?.label).toBe('private/model');
  expect(choices.find(m => m.id === 'test/embed')?.disabled).toBe('不支持工具');
  expect(choices.find(m => m.id === 'other/test')?.disabled).toContain('配置');
});
