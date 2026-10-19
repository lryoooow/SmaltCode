import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { DesktopBridge } from '../src/main/bridge.js';
import { isProjectTrusted } from '../../kernel/src/config/trust.js';
import { apiKeyFor } from '@smalt/kernel';

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), home: '', ask: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.home, commandLine: { hasSwitch: () => false } },
  ipcMain: { handle: (name: string, fn: any) => mocks.handlers.set(name, fn), removeHandler: (name: string) => mocks.handlers.delete(name) },
  dialog: { showMessageBox: mocks.ask, showOpenDialog: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { fromWebContents: () => undefined }, shell: { showItemInFolder: vi.fn() },
}));
let directory: string, workspace: string, previous: string | undefined, bridge: DesktopBridge;
const pageURL = 'file:///desktop/index.html';
class Contents extends EventEmitter {
  mainFrame = { url: pageURL };
  getURL() { return pageURL; }
  isDestroyed() { return false; }
  send() {}
}
let contents: Contents;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'smalt-bridge-')); mocks.home = directory;
  previous = process.env.SMALT_HOME; process.env.SMALT_HOME = join(directory, 'home');
  workspace = join(directory, 'project'); mkdirSync(join(workspace, '.smalt'), { recursive: true });
  mkdirSync(process.env.SMALT_HOME, { recursive: true });
  writeFileSync(join(process.env.SMALT_HOME, 'workspace-access.json'), JSON.stringify([process.platform === 'win32' ? realpathSync(workspace).toLowerCase() : realpathSync(workspace)]));
  writeFileSync(join(workspace, '.smalt/settings.json'), JSON.stringify({ permissions: { allow: ['shell'], deny: ['read:secret.txt'] } }));
  mocks.ask.mockResolvedValue({ response: 1 }); contents = new Contents();
  bridge = new DesktopBridge(contents as any, pageURL);
});
afterEach(() => { bridge.dispose(); mocks.ask.mockClear(); if (previous === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previous; rmSync(directory, { recursive: true, force: true }); });
const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
describe('desktop IPC and project trust', () => {
  it('persists per-model capacity overrides, restores automatic capacity and rejects malformed limits', async () => {
    const save = mocks.handlers.get('smalt:settings:save')!;
    await save(event(), { providers: { deepseek: { modelContextWindows: { 'deepseek-v4-pro': 256000 } } } });
    expect(bridge.kernel.gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(256000);
    expect((await mocks.handlers.get('smalt:settings:load')!(event())).providers.deepseek.modelContextWindows).toEqual({ 'deepseek-v4-pro': 256000 });
    await save(event(), { providers: { deepseek: { modelContextWindows: { 'deepseek-v4-pro': null } } } });
    expect(bridge.kernel.gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(1000000);
    await expect(save(event(), { providers: { deepseek: { modelContextWindows: { other: -1 } } } })).rejects.toThrow('窗口无效');
  });
  it('requires native consent for a renderer-supplied workspace and retains approved scope', async () => {
    const other = join(directory, 'other'); mkdirSync(other); writeFileSync(join(other, 'file.txt'), 'consented fixture');
    const context = mocks.handlers.get('smalt:context')!;
    await expect(context(event(), other, 'preview', 'file.txt')).rejects.toThrow('未允许');
    mocks.ask.mockResolvedValue({ response: 0 });
    expect(await context(event(), other, 'preview', 'file.txt')).toMatchObject({ text: 'consented fixture' });
    const count = mocks.ask.mock.calls.length;
    await context(event(), other, 'preview', 'file.txt'); expect(mocks.ask).toHaveBeenCalledTimes(count);
  });
  it('does not silently elevate a thread into bypass mode', async () => {
    await expect(mocks.handlers.get('smalt:call')!(event(), 'thread/start', { cwd: workspace, permissionMode: 'bypassPermissions' })).rejects.toThrow('取消权限');
    expect(bridge.kernel.threads.listMetas()).toHaveLength(0);
  });
  it('does not transfer existing credentials when a service address changes', async () => {
    const save = mocks.handlers.get('smalt:settings:save')!;
    await save(event(), { providers: { openai: { apiKey: 'fixture-main-only' } } });
    expect(apiKeyFor(bridge.kernel.gateway.providerConfig('openai'))).toBe('fixture-main-only');
    await expect(save(event(), { providers: { openai: { baseUrl: 'https://other.example/v1' } } })).rejects.toThrow('取消服务');
    expect(bridge.kernel.getSettings().providers.openai.baseUrl).toContain('api.openai.com');
    mocks.ask.mockResolvedValue({ response: 0 });
    await save(event(), { providers: { openai: { baseUrl: 'https://other.example/v1' } } });
    expect(apiKeyFor(bridge.kernel.gateway.providerConfig('openai'))).toBeUndefined();
    expect(() => bridge.kernel.gateway.adapterFor('openai')).toThrow('旧密钥');
    const settings = await mocks.handlers.get('smalt:settings:load')!(event()); expect(settings.providers.openai.hasKey).toBe(false);
  });
  it('rejects oversized and malformed reverse-request responses', () => {
    expect(() => mocks.handlers.get('smalt:input:respond')!(event(), 'id', 'x'.repeat(20001))).toThrow('Invalid');
    expect(() => mocks.handlers.get('smalt:input:respond')!(event(), {}, 'text')).toThrow('Invalid');
    expect(() => mocks.handlers.get('smalt:approval:respond')!(event(), 'id', { decision: 'deny', reason: {} })).toThrow('Invalid');
  });
  it('opens the trust dialog and preserves restrictive mode after rejection', async () => {
    await mocks.handlers.get('smalt:call')!(event(), 'thread/start', { cwd: workspace });
    expect(mocks.ask).toHaveBeenCalledOnce(); expect(isProjectTrusted(workspace)).toBe(false);
  });
  it('records explicit trust and prompts again after config changes', async () => {
    mocks.ask.mockResolvedValue({ response: 0 });
    await mocks.handlers.get('smalt:call')!(event(), 'thread/start', { cwd: workspace });
    expect(isProjectTrusted(workspace)).toBe(true);
    writeFileSync(join(workspace, '.smalt/settings.json'), JSON.stringify({ permissions: { allow: ['shell', 'write'] } }));
    mocks.ask.mockResolvedValue({ response: 1 });
    await mocks.handlers.get('smalt:call')!(event(), 'thread/start', { cwd: workspace });
    expect(mocks.ask).toHaveBeenCalledTimes(2); expect(isProjectTrusted(workspace)).toBe(false);
  });
  it('refuses subframes and foreign local file pages', async () => {
    await expect(mocks.handlers.get('smalt:call')!({ sender: contents, senderFrame: { url: pageURL } }, 'thread/list')).rejects.toThrow('permitted');
    contents.mainFrame.url = 'file:///untrusted.html';
    await expect(mocks.handlers.get('smalt:call')!(event(), 'thread/list')).rejects.toThrow('permitted');
  });
  it.each(['smalt:skills', 'smalt:models:list', 'smalt:attachments:pick', 'smalt:attachments:image', 'smalt:attachments:preview', 'smalt:overview', 'smalt:diagnostics:export', 'smalt:context'])('rejects untrusted access to %s before reading external content', async channel => {
    const invoke = () => mocks.handlers.get(channel)!({ sender: contents, senderFrame: { url: pageURL } }, 'list');
    await expect(Promise.resolve().then(invoke)).rejects.toThrow('untrusted');
  });
  it('requires an exact preview token to import and keeps the confirmed skill disabled', async () => {
    const skills = mocks.handlers.get('smalt:skills')!;
    const text = '---\nname: 测试导入\ndescription: 检查预览确认的完整路径\n---\n工作步骤';
    const preview = await skills(event(), 'preview-text', { text });
    expect(await skills(event(), 'list')).toHaveLength(3);
    await expect(skills(event(), 'confirm', { token: 'invented' })).rejects.toThrow('过期');
    const saved = await skills(event(), 'confirm', { token: preview.token });
    expect(saved).toMatchObject({ enabled: false, digest: preview.digest, name: '测试导入' });
    await expect(skills(event(), 'confirm', { token: preview.token })).rejects.toThrow('过期');
    expect(await skills(event(), 'list')).toHaveLength(4);
  });
});
