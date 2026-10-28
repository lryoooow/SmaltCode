// Test-only native visibility/geometry probe. Never loaded by the desktop bundle.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

module.exports = function installWindowProbe(paths) {
  let last = '';
  const state = () => {
    const win = BrowserWindow.getAllWindows().find(value => !value.isDestroyed());
    return win ? {
      visible: win.isVisible(), minimized: win.isMinimized(), size: win.getContentSize(),
      views: win.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed()).map(view => ({ url: view.webContents.getURL(), bounds: view.getBounds() })),
    } : null;
  };
  // Python may hold the destination open on Windows. Readers retry partial JSON;
  // an in-place write avoids rename/replace failing with EPERM under that reader.
  const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value));
  const record = () => {
    const value = state(), key = JSON.stringify(value);
    if (key !== last) {
      last = key; write(paths.state, value);
      fs.appendFileSync(paths.events, JSON.stringify({ at: Date.now(), ...value }) + '\n');
    }
    return value;
  };
  const timer = setInterval(() => {
    if (fs.existsSync(paths.control)) {
      const command = JSON.parse(fs.readFileSync(paths.control, 'utf8'));
      fs.unlinkSync(paths.control);
      const win = BrowserWindow.getAllWindows().find(value => !value.isDestroyed());
      if (!win) return;
      if (command.action === 'restore') { if (win.isMinimized()) win.restore(); win.showInactive(); }
      else if (command.action === 'minimize') win.minimize();
      else if (command.action === 'hide') win.hide();
      else if (command.action === 'resize') win.setSize(command.width, 820);
      else throw new Error('Unknown test window command');
      write(paths.ack, { sequence: command.sequence, state: record() });
    }
    record();
  }, 30);
  timer.unref(); app.once('will-quit', () => clearInterval(timer));
};
