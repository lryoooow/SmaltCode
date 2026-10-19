import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

/** Limit reads using the opened descriptor; growing/replaced files cannot exhaust main. */
export async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat(), current = await stat(path);
    if (!opened.isFile() || opened.size > limit) throw new Error('文件不是普通文件或超过读取上限');
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('文件在打开期间被替换');
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead; if (total > limit) throw new Error('文件在读取期间超过大小上限'); chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await stat(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== total || after.mtimeMs !== opened.mtimeMs) throw new Error('文件在读取期间发生变化');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
