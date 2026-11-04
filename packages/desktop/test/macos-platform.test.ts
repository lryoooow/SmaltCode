import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { windowChrome, shortcutText } from '../src/shared/platform';

const state = vi.hoisted(() => ({ app: undefined as any, menu: undefined as any, about: vi.fn(), setMenu: vi.fn() }));
vi.mock('electron', () => ({
  app: { on: (...args: any[]) => state.app.on(...args), getVersion: () => '0.0.6', setAboutPanelOptions: state.about },
  Menu: { buildFromTemplate: (menu: any) => { state.menu = menu; return menu; }, setApplicationMenu: state.setMenu },
}));
import { installDockActivation, installPlatformMenu, macMenuTemplate } from '../src/main/platform-menu';
beforeEach(() => { state.app = new EventEmitter(); state.menu = undefined; vi.clearAllMocks(); });

describe('macOS platform integration', () => {
  it('uses native traffic lights and reserves custom controls for other platforms', () => {
    expect(windowChrome('darwin')).toEqual({ frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } });
    expect(windowChrome('win32')).toEqual({ frame: false });
    expect(windowChrome('linux')).toEqual({ frame: false });
    expect(shortcutText('切换面板 (Ctrl+Shift+J)', 'darwin')).toBe('切换面板 (⌘+⇧+J)');
    expect(shortcutText('Ctrl N', 'win32')).toBe('Ctrl N');
    expect(shortcutText('Enter', 'darwin')).toBe('Enter');
  });
  it('uses native editing/close/quit roles and routes only navigation commands', () => {
    const command = vi.fn(), menu = macMenuTemplate(command);
    const entries = menu.flatMap(item => item.submenu as any[]);
    expect(entries.map(item => item.role)).toEqual(expect.arrayContaining(['quit', 'close', 'copy', 'paste', 'undo', 'selectAll', 'hide', 'services']));
    entries.find(item => item.accelerator === 'Command+N').click();
    entries.find(item => item.accelerator === 'Command+,').click();
    expect(command.mock.calls).toEqual([['new-task'], ['settings']]);
    expect(entries.some(item => item.role === 'forceReload' || item.role === 'toggleDevTools')).toBe(false);
  });
  it('restores the existing main window from Dock without creating a task or touching a conversation', () => {
    const show = vi.fn(); installDockActivation(show, 'darwin');
    state.app.emit('activate'); state.app.emit('activate');
    expect(show).toHaveBeenCalledTimes(2);
    const send = vi.fn(), win = { isDestroyed: () => false, webContents: { send } };
    installPlatformMenu(win as any, show, 'darwin');
    state.menu[1].submenu[0].click();
    expect(send).toHaveBeenCalledExactlyOnceWith('smalt:app-command', 'new-task');
    expect(state.about).toHaveBeenCalledWith({ applicationName: 'SmaltCode', applicationVersion: '0.0.6' });
  });
  it('does not install Mac menus or Dock listeners on Windows and ignores destroyed windows', () => {
    const show = vi.fn(), send = vi.fn();
    installDockActivation(show, 'win32'); installPlatformMenu({} as any, show, 'win32');
    expect(state.app.listenerCount('activate')).toBe(0); expect(state.setMenu).not.toHaveBeenCalled();
    installPlatformMenu({ isDestroyed: () => true, webContents: { send } } as any, show, 'darwin');
    state.menu[0].submenu[1].click(); expect(show).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});
