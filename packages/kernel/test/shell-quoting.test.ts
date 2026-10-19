import { afterEach, describe, expect, it } from 'vitest';
import { shellEnvironment, shellTool } from '../src/tools/defs/shell.js';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const previous = process.env.SMALT_SHELL;
afterEach(() => { if (previous === undefined) delete process.env.SMALT_SHELL; else process.env.SMALT_SHELL = previous; });
async function execute(command: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'smalt shell 中文 '));
  try {
    const events = [];
    for await (const event of shellTool.run({ command }, { cwd, signal: new AbortController().signal } as any)) events.push(event);
    return events.findLast(event => event.type === 'result');
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }); }
}
describe.skipIf(process.platform !== 'win32')('actual Windows cmd arguments', () => {
  it('preserves inner quotes, spaces, Unicode and quoted metacharacters', async () => {
    process.env.SMALT_SHELL = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const result = await execute(`"${process.execPath}" -e "console.log(JSON.stringify(['quoted spaces','中文','a&b']))"`);
    expect(result).toMatchObject({ isError: false });
    expect(result?.type === 'result' && result.text).toContain('["quoted spaces","中文","a&b"]');
    expect(shellEnvironment()).toContain('Semicolon is not a command separator');
  });
  it('preserves quoted scripts and the actual failing process exit status', async () => {
    process.env.SMALT_SHELL = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const result = await execute(`"${process.execPath}" -e "console.error('specific failure');process.exit(7)"`);
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'result' && result.text).toContain('[exit 7]');
    expect(result?.type === 'result' && result.text).toContain('specific failure');
  });
});
