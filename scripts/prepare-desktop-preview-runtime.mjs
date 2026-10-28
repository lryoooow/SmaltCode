/** A private branded copy of Electron; shared dependency bytes are never modified. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const manifestName = '.smalt-preview-runtime.json';
const executableName = 'SmaltCode Preview.exe';
const expectedBrandHashes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const comparePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (base, target) => {
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

function assertNoRedirects(root, target) {
  if (comparePath(target) !== comparePath(root) && !within(root, target)) throw new Error('Preview runtime path escaped its workspace');
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Preview runtime path must not contain links: ' + current);
  }
}

function files(directory, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Preview runtime must not contain links: ' + name);
    if (entry.isDirectory()) entries.push(...files(join(directory, entry.name), name));
    else if (entry.isFile()) entries.push(name);
    else throw new Error('Preview runtime contains an unsupported file: ' + name);
  }
  return entries.sort();
}

function brandExecutable(source, icoBytes, version) {
  const exe = NtExecutable.from(readFileSync(source), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(icoBytes);
  const sizes = icon.icons.map(item => item.data.width).sort((a, b) => a - b);
  if (JSON.stringify(sizes) !== JSON.stringify([16, 24, 32, 48, 64, 128, 256])) throw new Error('Canonical preview ICO must contain all seven sizes');
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(item => item.data));
  }
  const numeric = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!numeric) throw new Error('Invalid preview product version');
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (!versions.length) throw new Error('Electron executable has no version resource');
  for (const info of versions) {
    info.setFileVersion(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]), 0, 1033);
    info.setProductVersion(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]), 0, 1033);
    const languages = info.getAvailableLanguages();
    if (!languages.some(value => value.lang === 1033 && value.codepage === 1200)) languages.push({ lang: 1033, codepage: 1200 });
    for (const language of languages) info.setStringValues(language, {
        ProductName: 'SmaltCode 开发预览',
        FileDescription: 'SmaltCode 开发预览',
        InternalName: executableName,
        OriginalFilename: executableName,
        CompanyName: 'SmaltCode contributors',
      });
    info.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  return Buffer.from(exe.generate());
}

async function verifyRuntime(runtime, expected) {
  if (!lstatSync(runtime).isDirectory() || lstatSync(runtime).isSymbolicLink()) throw new Error('Preview runtime cache is not a plain directory');
  const metadata = lstatSync(join(runtime, manifestName));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) throw new Error('Preview runtime cache manifest is invalid');
  const stored = readJson(join(runtime, manifestName));
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error('Preview runtime cache manifest does not match the trusted source');
  const names = files(runtime).filter(name => name !== manifestName);
  const wanted = Object.keys(expected.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(wanted)) throw new Error('Preview runtime cache file list is incomplete or unexpected');
  for (const name of wanted) {
    if (await hashFile(join(runtime, ...name.split('/'))) !== expected.files[name]) throw new Error('Preview runtime cache file is damaged: ' + name);
  }
}

/** Refuse damaged caches; never delete or rewrite a runtime that may be running. */
export async function prepareDesktopPreviewRuntime(root, { cacheRoot } = {}) {
  const workspace = realpathSync(resolve(root));
  const sourceRuntime = realpathSync(join(workspace, 'node_modules/electron/dist'));
  const sourceExecutable = join(sourceRuntime, process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
  if (process.platform !== 'win32') return { executable: sourceExecutable, runtime: sourceRuntime, sourceExecutable, reused: true, branded: false };
  const product = readJson(join(workspace, 'packages/desktop/package.json'));
  const electron = readJson(join(workspace, 'node_modules/electron/package.json'));
  if (product.name !== '@smalt/desktop' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(electron.version)) throw new Error('Unexpected preview runtime package');
  const defaultCache = join(workspace, '.local-preview/runtime');
  const cache = resolve(cacheRoot ?? defaultCache);
  if (comparePath(cache) !== comparePath(defaultCache) && !within(join(workspace, '.qa-work'), cache)) throw new Error('Preview cache must use the private workspace runtime or an isolated QA subdirectory');
  assertNoRedirects(workspace, cache);
  const sourceNames = files(sourceRuntime);
  if (!sourceNames.includes('electron.exe') || !sourceNames.includes('resources/default_app.asar')) throw new Error('Electron source runtime lacks its executable or default application loader');
  const iconBytes = readFileSync(join(workspace, 'packages/desktop/assets/smalt.ico'));
  const iconHash = hash(iconBytes);
  const sourceHashes = {};
  for (const name of sourceNames) sourceHashes[name] = await hashFile(join(sourceRuntime, ...name.split('/')));
  const brandKey = [sourceHashes['electron.exe'], iconHash, product.version].join(':');
  let brandedBytes;
  let brandedHash = expectedBrandHashes.get(brandKey);
  if (!brandedHash) {
    brandedBytes = brandExecutable(sourceExecutable, iconBytes, product.version);
    brandedHash = hash(brandedBytes);
    expectedBrandHashes.clear();
    expectedBrandHashes.set(brandKey, brandedHash);
  }
  const expectedFiles = Object.fromEntries(Object.entries(sourceHashes).filter(([name]) => name !== 'electron.exe'));
  expectedFiles[executableName] = brandedHash;
  const expected = {
    schema: 1,
    kind: 'smaltcode-preview-runtime',
    electronVersion: electron.version,
    appVersion: product.version,
    iconHash,
    sourceExeHash: sourceHashes['electron.exe'],
    brandedExeHash: brandedHash,
    executable: executableName,
    files: Object.fromEntries(Object.entries(expectedFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  const key = electron.version + '-' + product.version + '-' + iconHash.slice(0, 24);
  const runtime = join(cache, key);
  assertNoRedirects(workspace, runtime);
  const result = reused => ({ executable: join(runtime, executableName), runtime, sourceRuntime, sourceExecutable, reused, branded: true, electronVersion: electron.version, appVersion: product.version, iconHash, manifest: join(runtime, manifestName) });
  if (existsSync(runtime)) {
    await verifyRuntime(runtime, expected);
    return result(true);
  }
  mkdirSync(cache, { recursive: true });
  assertNoRedirects(workspace, cache);
  const staging = join(cache, key + '.preparing-' + randomUUID());
  mkdirSync(staging);
  try {
    for (const name of sourceNames) {
      if (name === 'electron.exe') continue;
      const target = join(staging, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceRuntime, ...name.split('/')), target);
    }
    brandedBytes ??= brandExecutable(sourceExecutable, iconBytes, product.version);
    if (hash(brandedBytes) !== brandedHash) throw new Error('Electron source changed during preview preparation');
    writeFileSync(join(staging, executableName), brandedBytes, { flag: 'wx' });
    writeFileSync(join(staging, manifestName), JSON.stringify(expected, null, 2) + '\n', { flag: 'wx' });
    await verifyRuntime(staging, expected);
    if (await hashFile(sourceExecutable) !== sourceHashes['electron.exe']) throw new Error('Electron source changed during preview preparation');
    if (existsSync(runtime)) {
      await verifyRuntime(runtime, expected);
      return { ...result(true), retainedStaging: staging };
    }
    renameSync(staging, runtime);
    return result(false);
  } catch (error) {
    throw new Error('Preview runtime preparation failed; existing runtimes were not modified. Retained files: ' + staging, { cause: error });
  }
}
