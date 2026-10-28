// Test-only: one correlated negative reply from an otherwise real Office worker.
// The native document remains open; no working/original file or product IPC changes.
const cp = require('node:child_process');
const fs = require('node:fs');
module.exports = function injectCheckpointFailureOnce(flag) {
  const spawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = spawn.apply(this, args);
    if (!Array.isArray(args[1]) || !args[1].some(value => String(value).endsWith('libreoffice-worker.py')) || !child.stdin || !child.stdout) return child;
    const write = child.stdin.write;
    child.stdin.write = function (data, ...rest) {
      let request;
      try { request = JSON.parse(String(data)); } catch { return write.call(this, data, ...rest); }
      if (request.action === 'checkpoint' && fs.existsSync(flag)) {
        fs.unlinkSync(flag);
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: request.id, nonce: request.nonce, ok: false, value: { code: 'office-test-checkpoint-failed' } }) + '\n'));
        return true;
      }
      return write.call(this, data, ...rest);
    };
    return child;
  };
};
