const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
if (process.platform !== 'darwin') throw new Error('Native Mac PTY acceptance requires macOS');
const pty = require(process.argv[2]);
const work = mkdtempSync(join(process.argv[3], 'pty-'));
const a = join(work, '中文 A'), b = join(work, '中文 B'); mkdirSync(a); mkdirSync(b);
const children = new Set();
function session(cwd, token) {
  return new Promise((resolve, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', `printf '%s\\n' "$PWD"; read input; printf 'reply:%s\\n' "$input"`], { cwd, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24 });
    children.add(child); let output = '';
    const timer = setTimeout(() => reject(Error('Mac PTY response timed out')), 10_000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      children.delete(child);
      clearTimeout(timer);
      try { assert.equal(exitCode, 0); assert(output.includes(cwd)); assert(output.includes('reply:' + token)); resolve(output); }
      catch (error) { reject(error); }
    });
    child.write(token + '\r');
  });
}
(async () => {
  try {
    const [left, right] = await Promise.all([session(a, 'session-A'), session(b, 'session-B')]);
    assert(!left.includes('reply:session-B')); assert(!right.includes('reply:session-A'));
    console.log('[mac-pty] native ABI, executable helper, Unicode cwd, input, isolation and natural exit passed');
  } finally { for (const child of children) { try { child.kill(); } catch {} } }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
