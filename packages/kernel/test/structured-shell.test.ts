import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellTool } from '../src/tools/defs/shell.js';
import type { ToolEvent, ToolRunContext } from '../src/tools/types.js';
let cwd: string;
const previous = process.env.SMALT_SHELL;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'smalt argv 中文 ')); process.env.SMALT_SHELL = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh'; });
afterEach(async () => { if (previous === undefined) delete process.env.SMALT_SHELL; else process.env.SMALT_SHELL = previous; await rm(cwd, { recursive: true, force: true, maxRetries: 5 }); });
async function run(input: object, signal = new AbortController().signal) {
  const events: ToolEvent[] = [];
  for await (const event of shellTool.run(input, { cwd, signal } as ToolRunContext)) events.push(event);
  return events.findLast((e): e is Extract<ToolEvent, { type: 'result' }> => e.type === 'result')!;
}
describe('single-process command execution on the actual OS', () => {
  it('passes literal quotes, shell operators, Unicode and percent variables without expansion', async () => {
    const literals = ['a&b', 'a|b', '中文 空格', '"quoted"', '%ERRORLEVEL%', '$HOME', 'a\nb'];
    const result = await run({ program: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...literals] });
    expect(result.isError).toBe(false); expect(result.text).toContain(JSON.stringify(literals)); expect(result.assessment).toMatchObject({ source: 'process', exitCode: 0 });
  });
  it('returns the real nonzero exit code and rejects shell interpreters in process mode', async () => {
    expect(await run({ program: process.execPath, args: ['-e', 'process.exit(7)'] })).toMatchObject({ isError: true, assessment: { exitCode: 7, source: 'process' } });
    expect(await run({ program: process.platform === 'win32' ? 'cmd.exe' : 'sh', args: ['/c', 'exit 0'] })).toMatchObject({ isError: true, assessment: { code: 'invalidInvocation' } });
    expect(await run({ program: 'smalt-definitely-unavailable-evaluation-program', args: [] })).toMatchObject({ isError: true, assessment: { code: 'commandUnavailable', exitCode: null } });
  });
  it('validates exclusive input, argument types, timeout and working-directory boundaries', async () => {
    for (const input of [{}, { command: 'echo hi', program: 'node' }, { program: 'node', args: [3] }, { program: 'node', timeoutMs: NaN }, { program: 'node', cwd: '..' }]) expect((await run(input)).isError).toBe(true);
    await mkdir(join(cwd, 'nested'));
    const result = await run({ program: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: 'nested' });
    expect(result.isError).toBe(false); expect(result.text).toContain(join(cwd, 'nested'));
  });
  it('reports timeout even when a child attempts to stay alive', async () => {
    const result = await run({ program: process.execPath, args: ['-e', 'setInterval(()=>{},100)'], timeoutMs: 100 });
    expect(result).toMatchObject({ isError: true, assessment: { kind: 'error', code: 'timeout' } });
  });
  it.skipIf(process.platform !== 'win32')('executes a single batch wrapper and detects the cmd trailing-echo trap', async () => {
    await writeFile(join(cwd, 'pnpm.cmd'), '@echo off\r\necho 1 failed\r\nexit /b 1\r\n');
    expect(await run({ program: 'pnpm', args: ['test'] })).toMatchObject({ isError: false, assessment: { kind: 'finding', exitCode: 1, source: 'process' } });
    const masked = await run({ command: 'pnpm test & echo EXIT_CODE=%ERRORLEVEL%' });
    expect(masked).toMatchObject({ isError: false, assessment: { kind: 'unverified', code: 'exitCodeConflict', exitCode: 0 } });
    expect(await run({ program: 'pnpm', args: ['test', 'x&echo injected'] })).toMatchObject({ isError: true, assessment: { code: 'invalidInvocation' } });
  });
});
