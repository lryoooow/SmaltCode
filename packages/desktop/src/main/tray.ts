import { app, Menu, Tray, type BrowserWindow } from 'electron';

/** Window close hides the app; only explicit tray quit terminates it. */
export class DesktopTray {
  private readonly tray: Tray;
  private quitting = false;
  constructor(private readonly window: BrowserWindow, icon: string) {
    this.tray = new Tray(icon);
    this.tray.setToolTip('SmaltCode · 后台运行');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 SmaltCode', click: () => this.show() },
      { type: 'separator' },
      { label: '退出 SmaltCode', click: () => this.quit() },
    ]));
    this.tray.on('click', () => this.show());
    this.tray.on('double-click', () => this.show());
    window.on('close', event => {
      if (this.quitting) return;
      event.preventDefault(); window.hide();
      console.log('[tray] window hidden; background tasks remain active');
    });
    app.on('before-quit', () => { this.quitting = true; });
    app.on('will-quit', () => { this.tray.destroy(); });
  }
  show(): void { if (this.window.isMinimized()) this.window.restore(); this.window.show(); this.window.focus(); }
  quit(): void { this.quitting = true; app.quit(); }
  alive(): boolean { return !this.tray.isDestroyed(); }
}
