import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ app: undefined as any, tray: undefined as any, menu: [] as any[] }));
vi.mock('electron', () => ({
  app: { on: (...args: any[]) => state.app.on(...args), quit: () => state.app.quit() },
  Menu: { buildFromTemplate: (menu: any[]) => { state.menu = menu; return menu; } },
  Tray: class extends EventEmitter {
    destroyed = false; constructor(public icon: string) { super(); state.tray = this; }
    setToolTip = vi.fn(); setContextMenu = vi.fn(); isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  },
}));
import { DesktopTray } from '../src/main/tray.js';
beforeEach(() => { state.app = Object.assign(new EventEmitter(), { quit: vi.fn() }); state.menu = []; });
function fixture() {
  const window = Object.assign(new EventEmitter(), { hide: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(), isMinimized: () => false });
  const tray = new DesktopTray(window as any, 'canonical-logo.png');
  return { window, tray };
}
describe('desktop background residency', () => {
  it('closing hides the window and leaves the app/tray alive', () => {
    const { window, tray } = fixture(); const preventDefault = vi.fn();
    window.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(window.hide).toHaveBeenCalledOnce(); expect(state.app.quit).not.toHaveBeenCalled(); expect(tray.alive()).toBe(true);
  });
  it('click and tray open restore the window; tray quit really exits', () => {
    const { window } = fixture(); state.tray.emit('click');
    expect(window.show).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce();
    state.menu.find(item => item.label === '退出 SmaltCode').click(); expect(state.app.quit).toHaveBeenCalledOnce();
    const preventDefault = vi.fn(); window.emit('close', { preventDefault }); expect(preventDefault).not.toHaveBeenCalled();
    state.app.emit('will-quit'); expect(state.tray.isDestroyed()).toBe(true);
  });
});
