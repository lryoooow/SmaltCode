import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from '../src/tools/defs/read.js';
import type { ToolEvent, ToolRunContext } from '../src/tools/types.js';
let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'smalt-read-')); writeFileSync(join(cwd, 'text.txt'), 'first\nsecond\n'); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
async function read(input: object) { const events: ToolEvent[] = []; for await (const event of readTool.run(input, { cwd } as ToolRunContext)) events.push(event); return events.at(-1); }
describe('text read boundaries', () => {
  it.each([{ offset: 0 }, { offset: -1 }, { limit: -1 }, { limit: 0 }, { limit: 1.5 }])('rejects invalid ranges %s', async range => {
    expect(await read({ path: 'text.txt', ...range })).toMatchObject({ isError: true, text: expect.stringContaining('positive integers') });
  });
  it('returns zero rather than a negative count beyond EOF', async () => {
    expect(await read({ path: 'text.txt', offset: 40 })).toMatchObject({ text: '\n(0 of 2 lines)' });
  });
  it('rejects malformed UTF-8 rather than silently replacing bytes', async () => {
    writeFileSync(join(cwd, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x01]));
    expect(await read({ path: 'invalid.txt' })).toMatchObject({ isError: true });
  });
});
