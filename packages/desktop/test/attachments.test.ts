import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../src/main/attachments.js';
import { parseDocument } from '../src/main/document-parser.js';
import { DocumentReader } from '../src/main/document-reader.js';

let dir: string, store: AttachmentStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'smalt-attachments-')); store = new AttachmentStore(join(dir, 'attachments'), dir, parseDocument); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it('keeps an immutable consented copy, validates selections and detects cache tampering', async () => {
  const original = join(dir, '资料.txt'); await writeFile(original, '资料原文');
  const file = await store.fromFile(original); await writeFile(original, 'changed');
  const ref = { path: 'attachment:' + file.id, digest: file.digest };
  expect((await store.preview(file.id)).text).toBe('资料原文');
  expect((await store.resolve([{ ...ref, start: 0, end: 2 }])).text).toContain('资料');
  await expect(store.resolve([{ ...ref, digest: 'old' }])).rejects.toThrow('变化');
  await expect(store.resolve([{ ...ref, start: 0, end: 900 }])).rejects.toThrow('选区');
  await writeFile(join(dir, 'attachments', file.id + '.data'), 'tampered');
  await expect(store.preview(file.id)).rejects.toThrow('变化');
});
it('rejects path traversal, sensitive files, invalid image data and non-file picks', async () => {
  await expect(store.preview('../settings')).rejects.toThrow('标识');
  const sensitive = join(dir, '.smalt'); await mkdir(sensitive); await writeFile(join(sensitive, 'id_rsa'), 'secret');
  await expect(store.fromFile(join(sensitive, 'id_rsa'))).rejects.toThrow('敏感');
  await expect(store.fromFile(dir)).rejects.toThrow('文件');
  await expect(store.fromImage('not base64!', 'image/png')).rejects.toThrow('无效');
  await expect(store.fromImage(Buffer.from('<script>').toString('base64'), 'image/png')).rejects.toThrow('格式');
});
it('persists real images as image parts and does not put base64 into text context', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vCEAAAAASUVORK5CYII=';
  const file = await store.fromImage(png, 'image/png');
  const result = await new AttachmentStore(join(dir, 'attachments'), dir, parseDocument).resolve([{ path: 'attachment:' + file.id, digest: file.digest }]);
  expect(result.images).toEqual([{ type: 'image', mimeType: 'image/png', dataBase64: png }]);
  expect(result.text).toBe(''); expect(result.references[0]?.label).toBe('粘贴截图.png');
});
it('recovers parser capacity after a worker exits without a reply', async () => {
  const worker = join(dir, 'empty.cjs'); await writeFile(worker, 'process.exit(0)');
  const reader = new DocumentReader(worker);
  await expect(reader.read('one.txt', Buffer.from('one'))).rejects.toThrow('停止');
  await writeFile(worker, "require('node:worker_threads').parentPort.postMessage({ok:true,value:{format:'text',text:'done',warnings:[]}})");
  expect((await reader.read('two.txt', Buffer.from('two'))).text).toBe('done');
  expect(await readFile(worker, 'utf8')).toContain('parentPort');
});
