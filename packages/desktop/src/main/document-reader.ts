import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { DocumentContent } from '../shared/documents.js';

/** worker_threads cannot load a virtual app.asar entry as a native file. */
export function documentWorkerPath(mainDirectory: string): string {
  return join(mainDirectory, 'document-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** At most two parsers run; a malformed document cannot stall the app loop. */
export class DocumentReader {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly workerPath: string) {}
  async read(name: string, bytes: Uint8Array): Promise<DocumentContent> {
    return this.job<DocumentContent>('read',name,bytes);
  }
  async job<T>(operation:'read'|'inspect'|'build',name:string,bytes:Uint8Array,changes?:import('../shared/artifacts.js').ArtifactChanges):Promise<T> {
    if (this.waiting.length >= 10) throw new Error('文档解析队列已满，请稍后再试');
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
    try {
      return await new Promise<T>((resolve, reject) => {
        const worker = new Worker(this.workerPath, { workerData: { operation, name, bytes, changes }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('文档解析超过 20 秒，已停止；请尝试较小的文件')); }, 20_000);
        timer.unref();
        const finish = () => { clearTimeout(timer); void worker.terminate(); };
        worker.once('message', result => { finish(); result?.ok ? resolve(result.value) : reject(new Error(result?.error ?? '文档解析失败')); });
        worker.once('error', error => { finish(); reject(new Error('文档解析中断：' + error.message)); });
        worker.once('exit', () => { clearTimeout(timer); reject(new Error('文档解析进程已停止，文件可能过大或损坏')); });
      });
    } finally { this.active--; this.waiting.shift()?.(); }
  }
}
