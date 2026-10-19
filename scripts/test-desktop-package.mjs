/** Verify shipped ASAR bytes and run the shipped parser in the shipped runtime. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { extractFile, statFile } from '@electron/asar';
import { strToU8, zipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'packages/desktop');
const releaseIndex = process.argv.indexOf('--release-dir');
if (releaseIndex >= 0 && !process.argv[releaseIndex + 1]) throw new Error('--release-dir requires a directory');
const release = releaseIndex >= 0 ? resolve(process.argv[releaseIndex + 1]) : join(app, 'release');
const runtime = join(release, 'win-unpacked');
const archive = join(runtime, 'resources/app.asar');
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
assert.equal(packaged.version, manifest.version);
assert.equal(packaged.main, 'dist/main/index.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
let checked = 0, unpacked = 0;
for (const file of files(join(app, 'dist'))) {
  // ASAR's filesystem API splits by the host path separator on Windows.
  const archiveName = relative(app, file);
  const name = archiveName.replaceAll('\\', '/');
  assert.equal(hash(extractFile(archive, archiveName)), hash(readFileSync(file)), 'Stale packaged file: ' + name);
  if (name === 'dist/main/document-worker.cjs' || name.startsWith('dist/main/pdf-assets/')) {
    assert.equal(statFile(archive, archiveName).unpacked, true, 'Worker resource must be unpacked: ' + name);
    assert.equal(hash(readFileSync(join(archive + '.unpacked', name))), hash(readFileSync(file)));
    unpacked++;
  }
  checked++;
}
for (const name of ['LICENSE', 'NOTICE']) assert.equal(hash(extractFile(archive, name)), hash(readFileSync(join(root, name))));
assert.ok(unpacked > 100, 'PDF font/CMap resources missing');

const work = join(root, '.qa-work'); mkdirSync(work, { recursive: true });
const fixture = mkdtempSync(join(work, 'package-parser-'));
const pack = entries => zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));
writeFileSync(join(fixture, '正文.docx'), pack({ 'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>安装包文档解析通过</w:t></w:r></w:p></w:body></w:document>' }));
writeFileSync(join(fixture, '数据.xlsx'), pack({
  'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="安装包表格" r:id="a"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
  'xl/worksheets/a.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>真实打包数据</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
}));
const text = 'BT /F1 18 Tf 40 100 Td (SmaltCode packaged PDF) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
];
let pdf = '%PDF-1.4\n', offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(fixture, '说明.pdf'), pdf);
const reader = join(fixture, 'reader.cjs');
await build({ entryPoints: [join(app, 'src/main/document-reader.ts')], outfile: reader, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const probe = join(fixture, 'probe.cjs');
writeFileSync(probe, `
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {DocumentReader,documentWorkerPath} = require('./reader.cjs');
(async()=>{
  assert.equal(process.versions.electron, ${JSON.stringify(manifest.devDependencies.electron)});
  const worker = documentWorkerPath(${JSON.stringify(join(archive, 'dist/main'))});
  assert.equal(worker, ${JSON.stringify(join(archive + '.unpacked', 'dist/main/document-worker.cjs'))});
  const reader = new DocumentReader(worker);
  const [word,sheet,pdf] = await Promise.all(['正文.docx','数据.xlsx','说明.pdf'].map(name=>reader.read(name,readFileSync(join(__dirname,name)))));
  assert.equal(word.text, '安装包文档解析通过');
  assert.deepEqual(sheet.sheets[0].rows[0], ['真实打包数据','42']);
  assert.ok(pdf.text.includes('SmaltCode packaged PDF'));
  await assert.rejects(reader.read('损坏.pdf', Buffer.from('broken')), /文件头/);
  assert.equal((await reader.read('正文.docx',readFileSync(join(__dirname,'正文.docx')))).format, 'docx');
  const result={passed:true,electron:process.versions.electron,node:process.versions.node,documents:['docx','xlsx','pdf'],invalidDocumentRejected:true,queueRecovered:true};
  writeFileSync(join(__dirname,'result.json'), JSON.stringify(result,null,2));
  console.log('[package-parser] passed', JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
`);
const result = spawnSync(join(runtime, 'SmaltCode.exe'), [probe], {
  cwd: fixture, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SMALT_HOME: join(fixture, 'home') },
  encoding: 'utf8', timeout: 35_000, windowsHide: true,
});
writeFileSync(join(fixture, 'runtime.log'), (result.stdout ?? '') + (result.stderr ?? ''));
if (result.error || result.status !== 0 || !result.stdout.includes('[package-parser] passed')) throw new Error('Packaged parser failed: ' + (result.error?.message ?? result.status) + '\n' + result.stdout + result.stderr);
console.log(`PASS: ${checked} packaged build files match; ${unpacked} worker/PDF resources unpacked; shipped Electron parsed DOCX/XLSX/PDF, rejected corrupt input and recovered its queue.`);
console.log('Package parser evidence: ' + fixture);
