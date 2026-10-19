import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './document-parser.js';
import { join } from 'node:path';

void parseDocument(workerData.name, new Uint8Array(workerData.bytes), join(__dirname, 'pdf-assets')).then(
  value => parentPort?.postMessage({ ok: true, value }),
  error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : '文档解析失败' }),
);
