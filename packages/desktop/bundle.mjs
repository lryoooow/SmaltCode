/**
 * esbuild pipeline for the desktop app:
 *   src/main/index.ts     → dist/main/index.js     (CJS, electron external)
 *   src/preload/index.ts  → dist/preload/index.js  (CJS, electron external)
 *   src/renderer/src/main.tsx → dist/renderer/app.js + app.css
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { fileURLToPath } from 'node:url';
import '../../scripts/create-app-icon.mjs';
import '../../scripts/sync-version.mjs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const rendererSource = join(here, 'src/renderer/src');
const require = createRequire(import.meta.url);
const pdfAssets = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfAssetData = Object.fromEntries(['cmaps', 'standard_fonts'].flatMap(folder => readdirSync(join(pdfAssets, folder)).filter(name => /\.(?:bcmap|pfb|ttf)$/.test(name)).map(name => [folder + '/' + name, readFileSync(join(pdfAssets, folder, name)).toString('base64')])));
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
  // Resolve the engine from source: a standalone desktop bundle must never
  // silently ship an older packages/kernel/dist alongside the latest renderer.
  alias: { '@smalt/kernel': join(root, 'packages/kernel/src/index.ts') },
  // the kernel is bundled in — no node_modules needed at runtime
});

await build({
  ...shared,
  entryPoints: [join(here, 'src/main/document-worker.ts')],
  outfile: join(here, 'dist/main/document-worker.cjs'),
  platform: 'node', format: 'cjs', target: 'node24',
  external: ['@napi-rs/canvas'],
  define: { 'import.meta.url': '__smaltImportMetaUrl' },
  banner: { js: "const __smaltImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});
for (const folder of ['cmaps', 'standard_fonts']) cpSync(join(pdfAssets, folder), join(here, 'dist/main/pdf-assets', folder), { recursive: true });
mkdirSync(join(here, 'dist/licenses'), { recursive: true });
for (const name of ['pdfjs-dist', 'fflate', 'fast-xml-parser', '@thednp/dommatrix']) {
  let packageDir = dirname(require.resolve(name));
  while (!existsSync(join(packageDir, 'package.json')) || JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name !== name) {
    const parent = dirname(packageDir);
    if (parent === packageDir) throw new Error('Cannot locate license for ' + name);
    packageDir = parent;
  }
  cpSync(join(packageDir, 'LICENSE'), join(here, 'dist/licenses', name.replace('/', '-') + '-LICENSE'));
}
cpSync(join(root, 'NOTICE'), join(here, 'dist/licenses/SmaltCode-NOTICE'));

const pdfWorker = await build({
  entryPoints: [require.resolve('pdfjs-dist/build/pdf.worker.mjs')],
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome144',
  write: false, minify: true, logLevel: 'warning',
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
    name: 'pdf-worker-source',
    setup(build) {
      build.onResolve({ filter: /^smalt-pdf-worker$/ }, () => ({ path: 'worker', namespace: 'pdf-worker-source' }));
      build.onLoad({ filter: /.*/, namespace: 'pdf-worker-source' }, () => ({ contents: 'export default ' + JSON.stringify(pdfWorker.outputFiles[0].text), loader: 'js' }));
      build.onResolve({ filter: /^smalt-pdf-assets$/ }, () => ({ path: 'assets', namespace: 'pdf-assets' }));
      build.onLoad({ filter: /.*/, namespace: 'pdf-assets' }, () => ({ contents: 'export default ' + JSON.stringify(pdfAssetData), loader: 'js' }));
    },
  }, {
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
cpSync(join(here, 'assets/smalt.ico'), join(here, 'dist/main/smalt.ico'));
