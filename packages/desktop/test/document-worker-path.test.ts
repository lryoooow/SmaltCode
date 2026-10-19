import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { documentWorkerPath } from '../src/main/document-reader.js';

describe('document worker location', () => {
  it('keeps source development paths unchanged', () => {
    expect(documentWorkerPath(join('source', 'dist', 'main'))).toBe(join('source', 'dist', 'main', 'document-worker.cjs'));
  });
  it('uses the real unpacked worker and adjacent PDF assets in a package', () => {
    expect(documentWorkerPath(join('程序 目录', 'resources', 'app.asar', 'dist', 'main')))
      .toBe(join('程序 目录', 'resources', 'app.asar.unpacked', 'dist', 'main', 'document-worker.cjs'));
  });
});
