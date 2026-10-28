import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from './document-parser.js';
import { join } from 'node:path';
import { inspectArtifact,buildArtifact } from './artifact-office.js';

void (async():Promise<unknown>=>workerData.operation==='inspect'?inspectArtifact(workerData.name,new Uint8Array(workerData.bytes)):workerData.operation==='build'?buildArtifact(workerData.name,new Uint8Array(workerData.bytes),workerData.changes):parseDocument(workerData.name, new Uint8Array(workerData.bytes), join(__dirname, 'pdf-assets')))().then(
  value => parentPort?.postMessage({ ok: true, value }),
  error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : '文档解析失败' }),
);
