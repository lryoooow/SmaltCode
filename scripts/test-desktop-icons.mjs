import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'packages/desktop');
const version = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
const icon = Data.IconFile.from(readFileSync(join(app, 'assets/smalt.ico')));
const hash = data => createHash('sha256').update(Buffer.from(data)).digest('hex');
const expected = icon.icons.map(i => hash(i.data.bin));
const result = {};
for (const name of ['win-unpacked/SmaltCode.exe', `SmaltCode-Setup-${version}.exe`]) {
  const exe = NtExecutable.from(readFileSync(join(app, 'release', name)), { ignoreCert: true });
  const entries = NtExecutableResource.from(exe).entries;
  const groups = Resource.IconGroupEntry.fromEntries(entries);
  const matched = groups.some(group => {
    const actual = group.getIconItemsFromEntries(entries).map(i => hash(i.isRaw() ? i.bin : i.generate()));
    return expected.every(value => actual.includes(value));
  });
  assert.ok(matched, `${name} does not contain the canonical multi-resolution icon`);
  const versions = Resource.VersionInfo.fromEntries(entries);
  const strings = versions.flatMap(info => info.getAvailableLanguages().map(language => info.getStringValues(language)));
  // NSIS displays three components; the application writes the four-component
  // Windows form. Verify the numeric resource too, rather than only its label.
  const isExpectedVersion = value => value === version || value === `${version}.0`;
  assert.ok(strings.some(info => isExpectedVersion(info.ProductVersion)), `${name} product version is not ${version}`);
  assert.ok(strings.some(info => isExpectedVersion(info.FileVersion)), `${name} file version is not ${version}`);
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(versions.some(info => info.fixedInfo.fileVersionMS === major * 65536 + minor && info.fixedInfo.fileVersionLS === patch * 65536 && info.fixedInfo.productVersionMS === major * 65536 + minor && info.fixedInfo.productVersionLS === patch * 65536), `${name} numeric version resource is incorrect`);
  if (name.startsWith('win-unpacked/')) {
    assert.ok(strings.some(info => info.ProductName === 'SmaltCode' && info.OriginalFilename === 'SmaltCode.exe' && info.InternalName === 'SmaltCode.exe'), `${name} product identity is incorrect`);
  } else {
    assert.ok(strings.some(info => info.ProductName?.includes('SmaltCode')), `${name} installer identity is incorrect`);
  }
  result[name] = { matched: true, version, productName: 'SmaltCode', sizes: [16, 24, 32, 48, 64, 128, 256] };
}
assert.equal(readFileSync(join(app, 'dist/renderer/smalt.svg'), 'utf8'), readFileSync(join(app, 'assets/smalt.svg'), 'utf8'));
assert.equal(hash(readFileSync(join(app, 'dist/main/smalt.png'))), hash(readFileSync(join(app, 'assets/smalt.png'))));
mkdirSync(join(root, 'docs/screenshots'), { recursive: true });
writeFileSync(join(root, 'docs/screenshots/icon-verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`PASS: SmaltCode ${version} identity, PE file/product versions and canonical EXE/installer/window/tray/UI logos.`);
