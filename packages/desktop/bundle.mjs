/**
 * esbuild pipeline for the desktop app:
 *   src/main/index.ts     → dist/main/index.js     (CJS, electron external)
 *   src/preload/index.ts  → dist/preload/index.js  (CJS, electron external)
 *   src/renderer/src/main.tsx → dist/renderer/app.js + app.css
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { fileURLToPath } from 'node:url';
import '../../scripts/create-app-icon.mjs';
import '../../scripts/sync-version.mjs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const rendererSource = join(here, 'src/renderer/src');
const require = createRequire(import.meta.url);
const pdfAssets = dirname(require.resolve('pdfjs-dist/package.json'));
const pdfAssetData = Object.fromEntries(['cmaps', 'standard_fonts'].flatMap(folder => readdirSync(join(pdfAssets, folder)).filter(name => /\.(?:bcmap|pfb|ttf)$/.test(name)).map(name => [folder + '/' + name, readFileSync(join(pdfAssets, folder, name)).toString('base64')])));
// Never erase the live preview before compiling, or replace a loaded native DLL.
// Stage native resources and publish only changed bytes; running readers keep
// their existing runtime. A compiler/copy failure leaves the main entry intact.
const stageRoot = resolve(root, '.build-stage'); mkdirSync(stageRoot, { recursive: true });
const native = mkdtempSync(join(stageRoot, 'desktop-native-'));
const nativeTarget = join(here, 'dist/main/native');
mkdirSync(native, { recursive: true });
const ptyRoot = dirname(require.resolve('node-pty/package.json'));
for (const name of ['lib', 'package.json', 'LICENSE']) cpSync(join(ptyRoot, name), join(native, 'node-pty', name), { recursive: true });
// node-pty 1.1.0 leaves its conout worker/input socket alive after natural exit.
// Patch only our staged, pinned copy; the close event already means output is drained.
if (JSON.parse(readFileSync(join(ptyRoot, 'package.json'), 'utf8')).version !== '1.1.0') throw new Error('Review the PTY lifecycle fix before changing node-pty version');
const terminalPath = join(native, 'node-pty/lib/windowsTerminal.js');
const terminalSource = readFileSync(terminalPath, 'utf8');
const closeLine = '_this.emit(\'exit\', _this._agent.exitCode);';
if (terminalSource.split(closeLine).length !== 2) throw new Error('PTY lifecycle patch no longer matches');
writeFileSync(terminalPath, terminalSource.replace(closeLine, '_this._agent.inSocket.destroy();\n                _this._agent._conoutSocketWorker.dispose();\n                ' + closeLine));
const ptyPlatform = process.platform + '-' + process.arch;
cpSync(join(ptyRoot, 'prebuilds', ptyPlatform), join(native, 'node-pty/prebuilds', ptyPlatform), { recursive: true, filter: path => !path.endsWith('.pdb') });
if (process.platform === 'win32') {
  const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const source = join(here, 'src/main/native/ProcessSupervisor.cs');
  const input = hash(Buffer.concat([readFileSync(source), readFileSync(compiler)]));
  const targetExe = join(nativeTarget, 'SmaltProcessSupervisor.exe'), targetStamp = join(nativeTarget, 'supervisor-build.json');
  let stamp; try { stamp = JSON.parse(readFileSync(targetStamp, 'utf8')); } catch { /* first build */ }
  if (stamp?.input === input && existsSync(targetExe) && stamp.output === hash(readFileSync(targetExe))) cpSync(targetExe, join(native, 'SmaltProcessSupervisor.exe'));
  else {
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/reference:System.Web.Extensions.dll', '/out:' + join(native, 'SmaltProcessSupervisor.exe'), source], { encoding: 'utf8', windowsHide: true });
    if (compiled.error || compiled.status !== 0) throw new Error('Process supervisor build failed: ' + (compiled.error?.message ?? compiled.stdout + compiled.stderr));
  }
  writeFileSync(join(native, 'supervisor-build.json'), JSON.stringify({ input, output: hash(readFileSync(join(native, 'SmaltProcessSupervisor.exe'))) }));
}
function publishNative(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isDirectory()) { publishNative(source, target); continue; }
    const bytes = readFileSync(source);
    if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
    const temporary = target + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, bytes); renameSync(temporary, target); }
    catch (error) { throw new Error('原生资源更新失败；请退出使用旧资源的开发预览后重试。' + String(error)); }
    finally { if (existsSync(temporary)) rmSync(temporary); }
  }
}
try { publishNative(native, nativeTarget); }
finally {
  // Only the newly created staging directory is eligible for recursive cleanup.
  if (dirname(resolve(native)) !== stageRoot || !resolve(native).startsWith(join(stageRoot, 'desktop-native-'))) throw new Error('Invalid native staging cleanup path');
  rmSync(native, { recursive: true, force: true });
}

const shared = {
  bundle: true,
  sourcemap: false,
  logLevel: 'info',
  plugins:[{name:'ssh-portable',setup(build){build.onResolve({filter:/^(?:cpu-features|\.\/crypto\/build\/Release\/sshcrypto\.node)$/},args=>({path:args.path,namespace:'ssh-portable'}));build.onLoad({filter:/.*/,namespace:'ssh-portable'},()=>({contents:"throw new Error('Optional SSH accelerator omitted');",loader:'js'}));}}],
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
await build({...shared,entryPoints:[join(here,'src/main/ssh-key-worker.ts')],outfile:join(here,'dist/main/ssh-key-worker.cjs'),platform:'node',format:'cjs',target:'node24'});
for(const file of ['ssh-supervisor.py','container-helper.py','container-forward.py','office-worker.ps1','libreoffice-worker.py','word_editor.py','calc_editor.py','impress_editor.py','office_notes.py','office_job.py'])cpSync(join(here,'src/main',file),join(here,'dist/main',file));
for (const folder of ['cmaps', 'standard_fonts']) cpSync(join(pdfAssets, folder), join(here, 'dist/main/pdf-assets', folder), { recursive: true });
mkdirSync(join(here, 'dist/licenses'), { recursive: true });
for (const name of ['js-yaml','argparse','minimatch','brace-expansion','balanced-match','tar-stream','bl','readable-stream','inherits','end-of-stream','once','wrappy','fs-constants','buffer','base64-js','ieee754','string_decoder','util-deprecate','ssh2','asn1','safer-buffer','bcrypt-pbkdf','tweetnacl','pdfjs-dist', 'fflate', 'fast-xml-parser', '@thednp/dommatrix', 'node-pty', '@xterm/xterm', '@xterm/addon-fit', '@modelcontextprotocol/client', '@modelcontextprotocol/core', 'ajv', 'fast-uri', 'fast-deep-equal', 'require-from-string', 'json-schema-traverse', 'cross-spawn', 'eventsource', 'eventsource-parser', 'jose', 'pkce-challenge', 'zod', 'which', 'path-key', 'shebang-command', 'shebang-regex', 'isexe']) {
  let packageDir = dirname(require.resolve(['buffer','string_decoder'].includes(name)?name+'/':name));
  while (!existsSync(join(packageDir, 'package.json')) || JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name !== name) {
    const parent = dirname(packageDir);
    if (parent === packageDir) throw new Error('Cannot locate license for ' + name);
    packageDir = parent;
  }
  const license = ['LICENSE', 'LICENSE.md', 'license'].find(file => existsSync(join(packageDir, file)));
  if (!license) throw new Error('Cannot locate license for ' + name);
  cpSync(join(packageDir, license), join(here, 'dist/licenses', name.replace('/', '-') + '-LICENSE'));
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

await build({...shared,entryPoints:[join(here,'src/preload/artifact.ts')],outfile:join(here,'dist/preload/artifact.js'),platform:'node',format:'cjs',target:'chrome120',external:['electron']});

await build({
  ...shared,
  entryPoints: [join(rendererSource, 'main.tsx'),join(rendererSource,'artifact.tsx')],
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
writeFileSync(join(here,'dist/renderer/artifact.html'),readFileSync(join(here,'src/renderer/index.html'),'utf8').replace('./main.css','./artifact.css').replace('./main.js','./artifact.js').replace('<title>SmaltCode</title>','<title>SmaltCode 成果审阅</title>'));
cpSync(join(here, 'assets/smalt.svg'), join(here, 'dist/renderer/smalt.svg'));
console.log('desktop bundle complete');
cpSync(join(here, 'assets/smalt.png'), join(here, 'dist/main/smalt.png'));
cpSync(join(here, 'assets/smalt.ico'), join(here, 'dist/main/smalt.ico'));
