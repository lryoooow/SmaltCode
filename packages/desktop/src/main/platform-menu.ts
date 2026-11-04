import { app, Menu, type MenuItemConstructorOptions, type BrowserWindow } from 'electron';
import type { AppCommand } from '../shared/platform.js';

/** Only trusted native menu clicks reach these two renderer navigation actions. */
export function macMenuTemplate(command: (value: AppCommand) => void): MenuItemConstructorOptions[] {
  return [
    { label: 'SmaltCode', submenu: [
      { role: 'about' },
      { label: '设置…', accelerator: 'Command+,', click: () => command('settings') },
      { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: '文件', submenu: [
      { label: '新建对话', accelerator: 'Command+N', click: () => command('new-task') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: '显示', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];
}

export function installPlatformMenu(window: BrowserWindow, show: () => void, platform = process.platform): void {
  if (platform !== 'darwin') return;
  app.setAboutPanelOptions({ applicationName: 'SmaltCode', applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(value => {
    if (window.isDestroyed()) return;
    show();
    window.webContents.send('smalt:app-command', value);
  })));
}

/** Dock click/reopen restores the resident main window without starting a new task. */
export function installDockActivation(show: () => void, platform = process.platform): void {
  if (platform === 'darwin') app.on('activate', show);
}
