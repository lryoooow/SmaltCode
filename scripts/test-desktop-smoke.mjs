import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages/desktop');
const packaged = process.argv.includes('--packaged');
const releaseIndex = process.argv.indexOf('--release-dir');
if (releaseIndex >= 0 && !process.argv[releaseIndex + 1]) throw new Error('--release-dir requires a directory');
const release = releaseIndex >= 0 ? resolve(process.argv[releaseIndex + 1]) : join(appDir, 'release');
const home = join(root, '.qa-work', packaged ? 'packaged-smoke' : 'smoke-regression');
mkdirSync(home, { recursive: true });
const env = { ...process.env, SMALT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const executable = packaged ? join(release, 'win-unpacked/SmaltCode.exe') : join(root, 'node_modules/electron/dist/electron.exe');
const launch = (entry = appDir) => spawnSync(executable, [...(packaged ? [] : [entry]), '--smoke-test'], { env, encoding: 'utf8', timeout: 25_000, windowsHide: true });
const html = join(appDir, 'dist/renderer/index.html');
const original = readFileSync(html, 'utf8');
const healthy = launch();
if (healthy.status !== 0) throw new Error('Healthy smoke failed: ' + healthy.stdout + healthy.stderr);
if (packaged) {
  if (!healthy.stdout.includes('[smoke] passed')) throw new Error('Packaged startup assertions did not complete');
  console.log('PASS: packaged application passed renderer, bridge, composer and kernel assertions.');
  process.exit(0);
}
// Broken fixtures live under .qa-work; the built renderer is never overwritten.
const fixture = mkdtempSync(join(home, 'broken-'));
const brokenHtml = join(fixture, 'index.html'), harness = join(fixture, 'harness.cjs');
writeFileSync(brokenHtml, original.replace(/<script[^>]+src="\.\/main\.js"><\/script>/, ''), 'utf8');
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
writeFileSync(harness, "const {app,BrowserWindow}=require('electron');app.getVersion=()=>" + JSON.stringify(version) + ";const load=BrowserWindow.prototype.loadFile;BrowserWindow.prototype.loadFile=function(){return load.call(this," + JSON.stringify(brokenHtml) + ");};require(" + JSON.stringify(join(appDir,'dist/main/index.js')) + ");");
const broken = launch(harness);
if (broken.status !== 1 || !broken.stdout.includes('assertions failed')) throw new Error('Broken page was not rejected: ' + broken.status + broken.stdout + broken.stderr);
console.log('PASS: healthy renderer exits 0; isolated blank renderer exits 1.');
