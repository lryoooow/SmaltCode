/**
 * esbuild pipeline for the desktop app:
 *   src/main/index.ts     → dist/main/index.js     (CJS, electron external)
 *   src/preload/index.ts  → dist/preload/index.js  (CJS, electron external)
 *   src/renderer/src/main.tsx → dist/renderer/app.js + app.css
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { fileURLToPath } from 'node:url';
import '../../scripts/create-app-icon.mjs';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const rendererSource = join(here, 'src/renderer/src');
rmSync(join(here, 'dist'), { recursive: true, force: true });

const shared = {
  bundle: true,
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [join(here, 'src/main/index.ts')],
  outfile: join(here, 'dist/main/index.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  // the kernel is bundled in — no node_modules needed at runtime
});

await build({
  ...shared,
  entryPoints: [join(here, 'src/preload/index.ts')],
  outfile: join(here, 'dist/preload/index.js'),
  platform: 'node',
  format: 'cjs',
  target: 'chrome120',
  external: ['electron'],
});

await build({
  ...shared,
  entryPoints: [join(rendererSource, 'main.tsx')],
  outdir: join(here, 'dist/renderer'),
  outExtension: { '.js': '.js' },
  platform: 'browser',
  // IIFE, not ESM: file:// pages have an opaque origin and Chromium refuses
  // to load module scripts cross-origin — the app would render nothing
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'css' },
  nodePaths: [join(root, 'node_modules')],
  plugins: [{
    name: 'tailwind',
    setup(build) {
      build.onLoad({ filter: /index\.css$/ }, async ({ path }) => {
        const compiler = await compile(readFileSync(path, 'utf8'), { base: root, onDependency() {} });
        const scanner = new Scanner({ sources: [{ base: rendererSource, pattern: '**/*.{tsx,ts}', negated: false }] });
        return { contents: compiler.build(scanner.scan()), loader: 'css' };
      });
    },
  }],
});

mkdirSync(join(here, 'dist/renderer'), { recursive: true });
cpSync(join(here, 'src/renderer/index.html'), join(here, 'dist/renderer/index.html'));
cpSync(join(here, 'assets/smalt.svg'), join(here, 'dist/renderer/smalt.svg'));
console.log('desktop bundle complete');
cpSync(join(here, 'assets/smalt.png'), join(here, 'dist/main/smalt.png'));
