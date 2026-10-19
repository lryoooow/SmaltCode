import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBounded } from '../src/main/read-bounded.js';
describe('bounded main-process reads', () => {
  it('accepts an exact limit, rejects oversized data and closes rejected descriptors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smalt-bounded-')), file = join(dir, 'file');
    try {
      await writeFile(file, '12345'); expect((await readBounded(file, 5)).toString()).toBe('12345');
      await expect(readBounded(file, 4)).rejects.toThrow('上限');
      await rm(file); await writeFile(file, 'next'); expect((await readBounded(file, 4)).toString()).toBe('next');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
