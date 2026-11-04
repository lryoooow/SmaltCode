import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Compile the actual worker, never a mock certificate generator. */
export function certificateWorkerFixture(): string {
  mkdirSync(resolve('.qa-work'), { recursive: true });
  const directory = mkdtempSync(resolve('.qa-work/certificate-worker-'));
  const outfile = join(directory, 'remote-certificate-worker.cjs');
  buildSync({ entryPoints: [resolve('packages/desktop/src/main/remote-certificate-worker.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  return outfile;
}
