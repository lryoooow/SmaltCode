/** Real private-cache/PE/launch verification. Retains QA evidence; never deletes runtimes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { prepareDesktopPreviewRuntime } from './prepare-desktop-preview-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
async function hashFile(file) {
  const h = createHash('sha256');
  for await (const bytes of createReadStream(file)) h.update(bytes);
  return h.digest('hex');
}
function names(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    assert(!entry.isSymbolicLink(), 'Unexpected QA link: ' + name);
    return entry.isDirectory() ? names(join(directory, entry.name), name) : [name];
  }).sort();
}
async function snapshot(directory) {
  const values = {};
  for (const name of names(directory)) {
    const file = join(directory, ...name.split('/'));
    values[name] = { sha256: await hashFile(file), bytes: statSync(file).size, mtime: statSync(file).mtimeMs };
  }
  return values;
}

function verifyBranding(file, version) {
  const source = Data.IconFile.from(readFileSync(join(root, 'packages/desktop/assets/smalt.ico')));
  const wanted = source.icons.map(icon => sha(icon.data.bin)).sort();
  const executable = NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const entries = NtExecutableResource.from(executable).entries;
  const groups = Resource.IconGroupEntry.fromEntries(entries);
  assert(groups.length > 0);
  for (const group of groups) {
    const actual = group.getIconItemsFromEntries(entries).map(icon => sha(icon.isRaw() ? icon.bin : icon.generate())).sort();
    assert.deepEqual(actual, wanted, 'A preview EXE icon group retains the Electron logo');
  }
  const versions = Resource.VersionInfo.fromEntries(entries);
  const strings = versions.flatMap(info => info.getAvailableLanguages().map(language => info.getStringValues(language)));
  assert(strings.length > 0);
  for (const value of strings) {
    assert.equal(value.ProductName, 'SmaltCode 开发预览');
    assert.equal(value.FileDescription, 'SmaltCode 开发预览');
    assert.equal(value.InternalName, 'SmaltCode Preview.exe');
    assert.equal(value.OriginalFilename, 'SmaltCode Preview.exe');
  }
  const [major, minor, patch] = version.split('.').map(Number);
  assert(versions.every(info => info.fixedInfo.fileVersionMS === major * 65536 + minor && info.fixedInfo.fileVersionLS === patch * 65536 && info.fixedInfo.productVersionMS === major * 65536 + minor && info.fixedInfo.productVersionLS === patch * 65536));
  assert(strings.some(value => value.ProductVersion === version || value.ProductVersion === version + '.0'));
  return { groups: groups.length, sizes: [16, 24, 32, 48, 64, 128, 256], version };
}

if (process.platform !== 'win32') {
  const result = await prepareDesktopPreviewRuntime(root);
  assert(!result.branded);
  console.log('PASS: non-Windows preview keeps the existing source runtime.');
} else {
  mkdirSync(join(root, '.qa-work'), { recursive: true });
  const qa = mkdtempSync(join(root, '.qa-work/preview-runtime-'));
  const sourceRuntime = join(root, 'node_modules/electron/dist');
  const before = await snapshot(sourceRuntime);
  const version = JSON.parse(readFileSync(join(root, 'packages/desktop/package.json'), 'utf8')).version;
  const first = await prepareDesktopPreviewRuntime(root, { cacheRoot: join(qa, 'cache') });
  assert.equal(first.reused, false);
  assert.equal(first.branded, true);
  assert(first.runtime.startsWith(qa));
  assert(!existsSync(join(first.runtime, 'electron.exe')));
  assert(existsSync(join(first.runtime, 'resources/default_app.asar')));
  assert.equal(await hashFile(join(first.runtime, 'resources/default_app.asar')), before['resources/default_app.asar'].sha256);
  const branding = verifyBranding(first.executable, version);
  const cached = await snapshot(first.runtime);

  // Use the actual default_app.asar loader, with no BrowserWindow or user profile.
  const loader = join(qa, 'source app with spaces');
  mkdirSync(loader);
  mkdirSync(join(loader, 'profile'));
  writeFileSync(join(loader, 'package.json'), JSON.stringify({ name: 'smalt-preview-runtime-qa', version, main: 'main.cjs' }));
  writeFileSync(join(loader, 'main.cjs'), "const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setName('SmaltCode Runtime QA');app.setPath('userData',path.join(__dirname,'profile'));if(process.platform==='win32')app.setAppUserModelId('app.smaltcode.desktop.test');app.whenReady().then(()=>{fs.writeFileSync(path.join(__dirname,'loaded.json'),JSON.stringify({defaultApp:process.defaultApp===true,path:app.getAppPath(),version:app.getVersion()}));app.exit(0)});");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const loaded = spawnSync(first.executable, [loader, '--identity-test'], { cwd: qa, env, encoding: 'utf8', timeout: 25000, windowsHide: true });
  assert.equal(loaded.status, 0, (loaded.error?.message ?? '') + loaded.stdout + loaded.stderr);
  const actual = JSON.parse(readFileSync(join(loader, 'loaded.json'), 'utf8'));
  assert.equal(actual.defaultApp, true);
  assert.equal(resolve(actual.path), resolve(loader));
  assert.equal(actual.version, version);

  const second = await prepareDesktopPreviewRuntime(root, { cacheRoot: join(qa, 'cache') });
  assert.equal(second.reused, true);
  assert.equal(second.executable, first.executable);
  assert.deepEqual(await snapshot(first.runtime), cached, 'Cache reuse rewrote a runtime file');
  assert.deepEqual(await snapshot(sourceRuntime), before, 'Shared Electron dependency bytes or timestamps changed');
  await assert.rejects(prepareDesktopPreviewRuntime(root, { cacheRoot: sourceRuntime }), /private workspace runtime/);

  // Hold the actual cache EXE open while damage is detected. The preparer must not repair in place.
  const child = spawn(first.executable, ['-e', "console.log('PREVIEW_RUNTIME_HELD');setInterval(()=>{},1000)"], { cwd: qa, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const childClosed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Private runtime did not start')), 12000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => { if (data.toString().includes('PREVIEW_RUNTIME_HELD')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error('Private runtime exited early: ' + code)); });
    });
    const resource = join(first.runtime, 'resources/default_app.asar');
    writeFileSync(resource, Buffer.concat([readFileSync(resource), Buffer.from('QA_CORRUPTED_CACHE')]));
    const damaged = await snapshot(first.runtime);
    await assert.rejects(prepareDesktopPreviewRuntime(root, { cacheRoot: join(qa, 'cache') }), /cache file is damaged/);
    assert.equal(child.exitCode, null);
    assert.deepEqual(await snapshot(first.runtime), damaged, 'Damaged running cache was overwritten');
    const metadata = JSON.parse(readFileSync(first.manifest, 'utf8'));
    metadata.schema = 999;
    writeFileSync(first.manifest, JSON.stringify(metadata));
    const badManifest = await snapshot(first.runtime);
    await assert.rejects(prepareDesktopPreviewRuntime(root, { cacheRoot: join(qa, 'cache') }), /cache manifest does not match/);
    assert.equal(child.exitCode, null);
    assert.deepEqual(await snapshot(first.runtime), badManifest, 'Damaged running cache manifest was overwritten');
  } finally {
    child.kill();
    let timer;
    try {
      await Promise.race([childClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('QA runtime did not exit')), 10000); })]);
    } finally {
      clearTimeout(timer);
    }
  }
  assert.deepEqual(await snapshot(sourceRuntime), before);
  const result = { passed: true, sharedElectronUntouched: true, sourceFiles: Object.keys(before).length, cacheReusedWithoutWrites: true, sourceDefaultAppLoaderPassed: true, damagedLiveCacheRefused: true, damagedManifestRefused: true, pathEscapeRejected: true, branding, qa, retainedRuntime: first.runtime };
  writeFileSync(join(qa, 'verification.json'), JSON.stringify(result, null, 2));
  console.log('PASS: ' + JSON.stringify(result));
}
