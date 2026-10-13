import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../src/main/bridge.js';
import { isProjectTrusted } from '../../kernel/src/config/trust.js';

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
  writeFileSync(join(workspace, '.smalt/settings.json'), JSON.stringify({ permissions: { allow: ['shell'], deny: ['read:secret.txt'] } }));
  mocks.ask.mockResolvedValue({ response: 1 }); contents = new Contents();
  bridge = new DesktopBridge(contents as any, pageURL);
});
afterEach(() => { bridge.dispose(); mocks.ask.mockClear(); if (previous === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previous; rmSync(directory, { recursive: true, force: true }); });
const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
describe('desktop IPC and project trust', () => {
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
});
