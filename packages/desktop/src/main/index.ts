/** smalt desktop — Electron main process (hardened). */

import { app, BrowserWindow, dialog, protocol } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitForToolProcesses } from '@smalt/kernel';
import { DesktopBridge } from './bridge.js';
import { DesktopTray } from './tray.js';
import { desktopAppId, desktopTestSwitches } from './identity.js';
import { configureDesktopStorage } from './desktop-storage.js';

app.setName('SmaltCode');
protocol.registerSchemesAsPrivileged([{ scheme: 'smalt-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const testing = desktopTestSwitches.some(flag => app.commandLine.hasSwitch(flag));
if (process.platform === 'win32') app.setAppUserModelId(desktopAppId(app.isPackaged, testing));

let tray: DesktopTray | undefined;
let bridge: DesktopBridge | undefined;
let exiting = false, cleaned = false;

if (process.env.SMALT_HOME && (testing || app.commandLine.hasSwitch('development-preview'))) app.setPath('userData', join(process.env.SMALT_HOME, testing ? 'desktop-test-profile' : 'desktop-preview-profile'));

// single instance: a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!process.env.SMALT_HOME) {
    try {
      process.env.SMALT_HOME = configureDesktopStorage({ appData: app.getPath('appData'), userHome: app.getPath('home') });
      app.setPath('userData', join(process.env.SMALT_HOME, 'desktop-profile'));
    } catch (error) {
      dialog.showErrorBox('本地存储暂不可用', String(error instanceof Error ? error.message : error)); app.exit(1);
    }
  }
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
    }
  });

  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 940,
      minHeight: 600,
      backgroundColor: '#131313',
      frame: false,
      opacity: app.commandLine.hasSwitch('tray-smoke-test') ? 0 : 1,
      focusable: !app.commandLine.hasSwitch('tray-smoke-test'),
      show: false,
      title: app.commandLine.hasSwitch('development-preview') ? 'SmaltCode 开发预览' : 'SmaltCode',
      icon: join(__dirname, 'smalt.png'),
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        additionalArguments: [`--smalt-version=${app.getVersion()}`, ...(app.commandLine.hasSwitch('development-preview') ? ['--smalt-development-preview'] : [])],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        offscreen: app.commandLine.hasSwitch('ui-test') && !app.commandLine.hasSwitch('tray-smoke-test'),
        backgroundThrottling: false,
      },
    });
    if (process.platform === 'win32') {
      win.setAppDetails({
        appId: desktopAppId(app.isPackaged, testing),
        appIconPath: join(__dirname, 'smalt.ico'), appIconIndex: 0,
        relaunchDisplayName: app.commandLine.hasSwitch('development-preview') ? 'SmaltCode 开发预览' : 'SmaltCode',
        relaunchCommand: app.isPackaged ? '"' + process.execPath + '"' : '"' + process.execPath + '" "' + app.getAppPath() + '"' + (app.commandLine.hasSwitch('development-preview') ? ' --development-preview' : ''),
      });
    }

    // Windows: soft Mica backdrop when supported (best-effort)
    try {
      win.setBackgroundMaterial?.('mica');
    } catch {
      /* older Windows / Electron */
    }

    // the app is a single local page: no navigation, no popups, ever
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    const rendererPath = join(__dirname, '..', 'renderer', 'index.html');
    const rendererURL = pathToFileURL(rendererPath).href;
    win.webContents.on('will-navigate', (e, url) => {
      if (url !== rendererURL) e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    if (app.commandLine.hasSwitch('smoke-test')) {
      win.webContents.on('render-process-gone', (_e, details) => {
        console.log(`[smoke] renderer gone: ${details.reason}`);
      });
    }

    win.once('ready-to-show', () => { if (!app.commandLine.hasSwitch('ui-test') && !app.commandLine.hasSwitch('smoke-test') && !app.commandLine.hasSwitch('tray-smoke-test')) win.show(); });
    win.loadFile(rendererPath);

    bridge = new DesktopBridge(win.webContents, rendererURL);
    if (!app.commandLine.hasSwitch('smoke-test')) tray = new DesktopTray(win, join(__dirname, 'smalt.png'));
    if (app.commandLine.hasSwitch('tray-smoke-test')) {
      win.webContents.once('did-finish-load', () => setTimeout(() => {
        win.close();
        if (win.isDestroyed() || win.isVisible() || !tray?.alive()) { console.error('[tray-smoke] close did not preserve the resident app'); app.exit(1); return; }
        tray.show();
        setTimeout(() => {
          if (!win.isVisible()) { console.error('[tray-smoke] tray show did not restore the window'); app.exit(1); return; }
          win.hide(); console.log('[tray-smoke] passed: close hides, tray survives, show restores, explicit quit exits');
          tray?.quit();
        }, 150);
      }, 1000));
    }

    if (app.commandLine.hasSwitch('smoke-test')) {
      const watchdog = setTimeout(() => { console.error('[smoke] startup timed out'); app.exit(1); }, 15_000)
      win.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(watchdog); console.error('[smoke] load failed', code, description); app.exit(1)
      })
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          let passed = false
          try {
            const state = await win.webContents.executeJavaScript('({rootChildren: document.getElementById("root")?.childElementCount ?? 0, bridge: typeof window.smalt?.call === "function", composer: !!document.querySelector("[data-testid=composer]"), connected: document.querySelector("footer")?.textContent.includes("内核已连接")})')
            passed = state.rootChildren > 0 && state.bridge && state.composer && state.connected
            console.log('[smoke]', JSON.stringify(state))
            if (process.env.SMALT_SMOKE_SHOT) {
              const image = await win.webContents.capturePage()
              const { writeFileSync } = await import('node:fs')
              writeFileSync(process.env.SMALT_SMOKE_SHOT, image.toPNG())
            }
          } catch (err) { console.error('[smoke] failed:', err) }
          clearTimeout(watchdog)
          console.log(passed ? '[smoke] passed' : '[smoke] assertions failed')
          app.exit(passed ? 0 : 1)
        }, 1500)
      })
    }
  });
}

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

// Keep the app alive until process-tree cleanup is confirmed, including tray quit.
app.on('before-quit', event => {
  if (cleaned) return;
  event.preventDefault();
  if (exiting) return;
  exiting = true;
  for (const meta of bridge?.kernel.threads.listMetas() ?? []) if (bridge?.kernel.threads.get(meta.id)?.stateMachine.isRunning()) bridge.kernel.threads.interrupt(meta.id);
  Promise.all([bridge?.shutdown(), waitForToolProcesses()]).then(() => {
    cleaned = true; app.quit();
  }).catch(error => {
    exiting = false; tray?.cancelQuit(); bridge?.cancelArtifactQuit();
    console.error('[shutdown]', error);
    void dialog.showMessageBox({ type: 'error', title: '进程清理未完成', message: '仍有进程未确认停止，应用保持驻留。', detail: String(error) + '\n请检查终端与后台进程，停止后再次从托盘退出。', buttons: ['返回检查'] });
  });
});
