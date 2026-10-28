// Test-only response delay: real authorization/thread creation finish first.
const { ipcMain } = require('electron');
const fs = require('node:fs');
module.exports = function holdOneThreadCreate(paths) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, fn) => handle(name, async (...args) => {
    const value = await fn(...args);
    if (name !== 'smalt:call' || args[1] !== 'thread/start' || !fs.existsSync(paths.hold)) return value;
    fs.unlinkSync(paths.hold); fs.writeFileSync(paths.ready, JSON.stringify({ threadId: value.threadId }));
    await new Promise(resolve => {
      const end = Date.now() + 10000;
      const poll = () => { if (fs.existsSync(paths.release) || Date.now() >= end) resolve(); else setTimeout(poll, 25); };
      poll();
    });
    return value;
  });
};
