import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiKeyFor, loadSettings } from '../src/config/settings.js';
import { ModelGateway } from '../src/models/gateway.js';
let dir: string, previous: string | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'smalt-binding-')); previous = process.env.SMALT_HOME; process.env.SMALT_HOME = join(dir, 'home'); mkdirSync(process.env.SMALT_HOME); });
afterEach(() => { if (previous === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
it('does not reuse a decrypted/session key for a changed provider endpoint', () => {
  const settings = loadSettings(dir); settings.providers.test = { baseUrl: 'https://first.example/v1', wire: 'chat' };
  const gateway = new ModelGateway(settings); gateway.overrideProvider('test', { apiKey: 'fixture' });
  const next = structuredClone(settings); next.providers.test!.baseUrl = 'https://second.example/v1'; next.providers.test!.apiKeyEndpoint = 'https://first.example/v1';
  gateway.updateSettings(next);
  expect(apiKeyFor(gateway.providerConfig('test'))).toBeUndefined();
  expect(() => gateway.adapterFor('test')).toThrow('旧密钥');
  gateway.overrideProvider('test', { apiKey: 'new-fixture' });
  expect(apiKeyFor(gateway.providerConfig('test'))).toBe('new-fixture');
  expect(() => gateway.adapterFor('unknown')).toThrow('Unknown');
});
it('keeps credential endpoint bindings when a gateway forks', () => {
  const settings = loadSettings(dir); settings.providers.test = { baseUrl: 'https://first.example/v1', wire: 'chat' };
  const gateway = new ModelGateway(settings); gateway.overrideProvider('test', { apiKey: 'fixture' });
  const next = structuredClone(settings); next.providers.test!.baseUrl = 'https://second.example/v1';
  expect(() => gateway.fork(next).adapterFor('test')).toThrow('旧密钥');
});
it('can load user-only settings without accidentally inheriting the real home as a project', () => {
  mkdirSync(join(dir, '.smalt')); writeFileSync(join(dir, '.smalt/settings.json'), JSON.stringify({ permissions: { mode: 'plan' } }));
  expect(loadSettings(dir).permissions.mode).toBe('plan');
  expect(loadSettings(dir, undefined, undefined, false).permissions.mode).toBe('default');
});
