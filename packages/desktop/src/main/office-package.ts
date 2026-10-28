import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { extname } from 'node:path';
import type { OfficeFormat } from '../shared/office.js';

// Check the characters seen by the native XML reader. Decode one XML layer;
// &amp;#83; remains literal text and is not decoded a second time.
function policyXML(source: string) {
  return source.replace(/&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos));/gi, (_match, numeric: string | undefined, named: string | undefined) => {
    if (!numeric) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named!.toLowerCase()]!;
    const hex = numeric[0]!.toLowerCase() === 'x', value = Number.parseInt(hex ? numeric.slice(1) : numeric, hex ? 16 : 10);
    if (![9, 10, 13].includes(value) && !(value >= 32 && value <= 0xd7ff || value >= 0xe000 && value <= 0xfffd || value >= 0x10000 && value <= 0x10ffff)) throw Error('Office XML 含无效字符引用，保留原件不启动编辑');
    return String.fromCodePoint(value);
  });
}

const externalFormula = /\b(?:WEBSERVICE|RTD|DDE|CALL|REGISTER\.ID|REGISTER|EXEC|EVALUATE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMAGE)\s*\(/i;
// XML text may be split by comments or CDATA. Inspect actual character data,
// preserving literal entity syntax inside CDATA and joining split Word fields.
function inspectText(xml: string, workbook: boolean) {
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: false, ignoreDeclaration: true, ignorePiTags: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, cdataPropName: '#cdata' }).parse(xml) as Record<string, unknown>[];
  const text = (values: Record<string, unknown>[], cdata = false): string => values.map(node => Object.entries(node).map(([key, value]) => {
    if (key === '#text') return cdata ? String(value) : policyXML(String(value));
    return Array.isArray(value) ? text(value, cdata || key === '#cdata') : '';
  }).join('')).join('');
  const pending = [...nodes], fields: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    for (const [key, value] of Object.entries(node)) {
      if (workbook && key === ':@' && value && typeof value === 'object') for (const [attribute, formula] of Object.entries(value)) {
        if (/^@_(?:\w+:)?formula[12]?$/i.test(attribute) && externalFormula.test(policyXML(String(formula)))) throw Error('工作簿包含网络或外部执行公式，保留原件不启动编辑引擎');
      }
      if (!Array.isArray(value)) continue;
      const name = key.split(':').at(-1);
      if (workbook && /^(?:f|definedName|formula[12]?|calculatedColumnFormula|totalsRowFormula)$/i.test(name!) && externalFormula.test(text(value))) throw Error('工作簿包含网络或外部执行公式，保留原件不启动编辑引擎');
      if (!workbook && name === 'instrText') fields.push(text(value));
      else for (const child of value) pending.push(child);
    }
  }
  if (/\b(?:INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE)\b/i.test(fields.reverse().join(''))) throw Error('包含外部关系、活动字段或无效 XML，保留原件不启动编辑');
}

/** Validate before native parsing. Active/linked content is intentionally excluded. */
export function officePackage(name: string, bytes: Uint8Array) {
  const format = extname(name).slice(1).toLowerCase() as OfficeFormat;
  if (!['docx', 'xlsx', 'pptx'].includes(format) || bytes.length > 15 * 1024 * 1024) throw Error('仅接入 15 MB 内 DOCX/XLSX/PPTX 工作副本');
  let total = 0, count = 0;
  const names = new Set<string>();
  const files = unzipSync(bytes, { filter: entry => {
    if (++count > (format === 'pptx' ? 5000 : 2000) || entry.originalSize > 16 * 1024 * 1024 || (total += entry.originalSize) > 64 * 1024 * 1024 || !entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..') || names.has(entry.name)) throw Error('Office 归档路径或解压大小不安全');
    names.add(entry.name); return true;
  } });
  const part = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[format];
  if (!files['[Content_Types].xml'] || !files[part]) throw Error('Office 文件类型与实际内容不一致');
  for (const [key, value] of Object.entries(files)) {
    if (/_xmlsignatures|vbaProject|activeX|embeddings|externalLinks|macrosheets|connections\.xml|queryTables|webExtensions|customUI|\.(?:svgz?|emf|wmf|eps|m?html?)$/i.test(key)) throw Error('包含签名、宏、外部数据或嵌入对象，不能交给编辑引擎');
    if (!/\.xml$|\.rels$/i.test(key)) continue;
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(value);
    if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw Error('包含外部关系、活动字段或无效 XML，保留原件不启动编辑');
    const decoded = policyXML(xml);
    if (format === 'xlsx' && /^xl\/.*\.xml$/i.test(key)) inspectText(xml, true);
    if (format === 'docx' && /^word\/.*\.xml$/i.test(key)) inspectText(xml, false);
    if (/TargetMode\s*=\s*["']External["']|(?:INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE)\b|<(?:\w+:)?altChunk\b|Target\s*=\s*["'](?:https?|file|ftp|smb):|macroEnabled/i.test(decoded)) throw Error('包含外部关系、活动字段或无效 XML，保留原件不启动编辑');
    if (/<(?:\w+:)?(?:documentProtection|sheetProtection|workbookProtection)\b[^>]*(?:enforcement|sheet|lockStructure|lockWindows|lockRevision)\s*=\s*["'](?:1|true|on)["']/i.test(decoded)) throw Error('文件有编辑保护，不能通过引擎绕过');
  }
  return { format, parts: Object.keys(files).sort(), files };
}
