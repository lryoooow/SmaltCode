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
  net: { isOnline: () => true }, powerMonitor: { on: () => {}, removeListener: () => {} },
  Notification: { isSupported: () => false },
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
  it('binds native file context independently of command cwd and rejects cross-task materials and foreign frames',async()=>{
    mocks.ask.mockResolvedValue({response:0});
    const local=mocks.handlers.get('smalt:local-space')!,files=mocks.handlers.get('smalt:file-context')!,call=mocks.handlers.get('smalt:call')!;
    await expect(async()=>files({sender:contents,senderFrame:{url:'https://foreign.invalid'}},'storage',{})).rejects.toThrow('不可信');
    const draft=await local(event(),'create');
    const {dialog}=await import('electron');vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:false,filePaths:[workspace]});
    const view=await files(event(),'add',{scope:draft.cwd,kind:'workspace'});expect(view.cwd).toBe(workspace);expect(view.output).toBe(draft.cwd);
    await files(event(),'add',{scope:draft.cwd,kind:'source'});
    const root=(await files(event(),'get',{scope:draft.cwd})).sources[0];
    writeFileSync(join(workspace,'material.txt'),'safe reference');
    const refs=await files(event(),'search',{scope:draft.cwd,rootId:root.id,query:'material'});
    const created=await call(event(),'thread/start',{cwd:workspace,fileScope:draft.cwd});
    const bound=await files(event(),'get',{scope:created.threadId});expect(bound.output).toBe(draft.cwd);expect(bound.cwd).toBe(workspace);expect(bound.bound).toBe(true);
    await expect(files(event(),'primary',{scope:created.threadId})).rejects.toThrow('固定');
    await expect(files(event(),'get',{scope:draft.cwd})).rejects.toThrow('草稿');
    const other=await call(event(),'thread/start',{});
    await expect(files(event(),'source-preview',{scope:other.threadId,path:refs.files[0].path})).rejects.toThrow('不属于');
    const resolved=await mocks.handlers.get('smalt:context')!(event(),workspace,'resolve',[{path:refs.files[0].path}],created.threadId,created.threadId);expect(resolved.text).toContain('safe reference');
    await expect(call(event(),'thread/start',{cwd:workspace,fileScope:draft.cwd})).rejects.toThrow('已使用');
  });
  it('rechecks an edited draft after native trust consent before creating a thread',async()=>{
    const draft=await mocks.handlers.get('smalt:local-space')!(event(),'create');const contexts=(bridge as any).filesContext.contexts;
    contexts.add(draft.cwd,workspace,'workspace');let consent!:()=>void;
    const pending=new Promise<void>(r=>{consent=r});mocks.ask.mockImplementationOnce(async()=>{await pending;return{response:0}});
    const start=mocks.handlers.get('smalt:call')!(event(),'thread/start',{cwd:workspace,fileScope:draft.cwd});
    await vi.waitFor(()=>expect(mocks.ask).toHaveBeenCalled());contexts.primary(draft.cwd);consent();
    await expect(start).rejects.toThrow('不一致');expect(bridge.kernel.threads.listMetas()).toHaveLength(0);
  });
  it('starts ordinary conversations without a project, folder picker or native folder consent and keeps files isolated', async () => {
    const call = mocks.handlers.get('smalt:call')!, local = mocks.handlers.get('smalt:local-space')!;
    await expect(local({ sender: contents, senderFrame: { url: 'https://foreign.invalid' } }, 'create')).rejects.toThrow('untrusted');
    const a = await call(event(), 'thread/start', {}), b = await call(event(), 'thread/start', {});
    expect(a.meta.localSpace).toBe(true); expect(a.meta.projectId).toBeUndefined(); expect(a.meta.cwd).not.toBe(b.meta.cwd);
    expect(mocks.ask).not.toHaveBeenCalled();
    const info = await local(event(), 'info'); await expect(call(event(), 'thread/start', { cwd: info.files })).rejects.toThrow('未知目录');
    await expect(call(event(), 'thread/start', { cwd: a.meta.cwd })).rejects.toThrow('属于另一段');
    expect(bridge.kernel.threads.read(a.threadId).meta.localSpace).toBe(true);
  });
  it('clears pending human questions when a managed goal is paused from its own controls', async () => {
    mocks.ask.mockResolvedValue({response:0}); vi.spyOn(bridge.kernel.gateway,'fork').mockReturnValue(bridge.kernel.gateway);vi.spyOn(bridge.kernel.gateway,'prepare').mockResolvedValue(256000);
    vi.spyOn(bridge.kernel.gateway,'stream').mockImplementation(async function*(){yield{type:'toolCallStart',id:'question',name:'ask_user'};yield{type:'toolCallDelta',id:'question',argsDelta:JSON.stringify({question:'测试暂停后的清理'})};yield{type:'done',finishReason:'toolCalls'};});
    const request=mocks.handlers.get('smalt:autonomy')!,g=await request(event(),'goal-save',{config:{cwd:workspace,title:'暂停问题清理',instructions:'需要人工信息时提问',model:'openai/fixture-model',mode:'default',completion:{kind:'review'},stopOnIssue:true,budget:{turns:2,requests:3,tools:3,tokens:60000,minutes:1}}});
    await request(event(),'goal-start',{id:g.id});await vi.waitFor(()=>expect((bridge as any).pendingInputs.size).toBe(1));await request(event(),'goal-control',{id:g.id,action:'pause'});expect((bridge as any).pendingInputs.size).toBe(0);expect((bridge as any).requestThreads.size).toBe(0);
  });
  it('denies browser and feedback IPC to child pages or frames before accessing any data', async () => {
    const foreign = { sender: contents, senderFrame: { url: 'https://evil.example' } };
    await expect(mocks.handlers.get('smalt:autonomy')!(foreign, 'list', {})).rejects.toThrow('untrusted');
    await expect(mocks.handlers.get('smalt:integrations')!(foreign, 'list', {})).rejects.toThrow('untrusted');
    await expect(mocks.handlers.get('smalt:browser')!(foreign, 'list', { threadId: 'any' })).rejects.toThrow('untrusted');
    await expect(mocks.handlers.get('smalt:feedback')!(foreign, 'read', { cwd: workspace, path: 'feedback:any' })).rejects.toThrow('untrusted');
  });
  it('keeps process IPC limited to trusted frames and denies terminal capability in plan mode or after native refusal', async () => {
    const request=mocks.handlers.get('smalt:processes')!;
    await expect(request({sender:contents,senderFrame:{url:'https://evil.example'}},'list',{})).rejects.toThrow('untrusted');
    const {threadId}=await bridge.kernel.handle('thread/start',{cwd:workspace,permissionMode:'plan'}) as any;
    await expect(request(event(),'terminal',{threadId})).rejects.toThrow('权限');
    await expect(request(event(),'stop',{threadId,id:String(process.pid)})).rejects.toThrow('不属于');
    const next=await bridge.kernel.handle('thread/start',{cwd:workspace}) as any;
    await expect(request(event(),'terminal',{threadId:next.threadId})).rejects.toThrow('取消终端授权');
    expect((await request(event(),'list',{})).processes).toHaveLength(0);
  });

  it('inspects references via trusted IPC, reports changed sources and refuses stale fixed versions on send', async () => {
    const context = mocks.handlers.get('smalt:context')!;
    writeFileSync(join(workspace, 'notes.md'), '第一行\n选择正文\n尾部');
    const initial = await context(event(), workspace, 'inspect', [{ path: 'notes.md' }]);
    expect(initial.entries[0]).toMatchObject({ valid: true, kind: 'workspace', characters: 11 });
    const digest = initial.entries[0].digest;
    writeFileSync(join(workspace, 'notes.md'), '当前新版本');
    const changed = await context(event(), workspace, 'inspect', [{ path: 'notes.md', digest }]);
    expect(changed.entries[0]).toMatchObject({ valid: false }); expect(changed.entries[0].error).toContain('来源已变化');
    await expect(context(event(), workspace, 'resolve', [{ path: 'notes.md', digest }])).rejects.toThrow('来源已变化');
    expect((await context(event(), workspace, 'resolve', [{ path: 'notes.md', digest: changed.entries[0].digest }])).text).toContain('当前新版本');
    const denied = await context(event(), workspace, 'inspect', [{ path: '../outside.md' }]);
    expect(denied.entries[0]).toMatchObject({ valid: false });
    await expect(context({ sender: contents, senderFrame: { url: 'https://evil.example' } }, workspace, 'inspect', [])).rejects.toThrow('untrusted');
  });

  it('persists per-model capacity overrides, restores automatic capacity and rejects malformed limits', async () => {
    const save = mocks.handlers.get('smalt:settings:save')!;
    await save(event(), { providers: { deepseek: { modelContextWindows: { 'deepseek-v4-pro': 256000 } } } });
    expect(bridge.kernel.gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(256000);
    expect((await mocks.handlers.get('smalt:settings:load')!(event())).providers.deepseek.modelContextWindows).toEqual({ 'deepseek-v4-pro': 256000 });
    await save(event(), { providers: { deepseek: { modelContextWindows: { 'deepseek-v4-pro': null } } } });
    expect(bridge.kernel.gateway.contextWindowFor({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toBe(1048576);
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
  it.each(['smalt:ssh','smalt:artifacts','smalt:remote', 'smalt:skills', 'smalt:models:list', 'smalt:attachments:pick', 'smalt:attachments:image', 'smalt:attachments:preview', 'smalt:overview', 'smalt:diagnostics:export', 'smalt:context'])('rejects untrusted access to %s before reading external content', async channel => {
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
