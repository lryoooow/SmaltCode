import { extname, posix } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { DocumentContent } from '../shared/documents.js';

export const DOCUMENT_LIMIT = 15 * 1024 * 1024;
const TEXT_LIMIT = 200_000;
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const scalar = (value: unknown): string => value === undefined || value === null ? '' : typeof value === 'object' ? scalar((value as Record<string, unknown>)['#text']) : String(value);

export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  const data = Buffer.from(bytes);
  let width = 0, height = 0;
  let mime: 'image/png' | 'image/jpeg';
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 图片头无效');
    width = data.readUInt32BE(16); height = data.readUInt32BE(20); mime = 'image/png';
  } else if (data[0] === 255 && data[1] === 216 && data[2] === 255) {
    mime = 'image/jpeg';
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset] !== 255) break;
      const marker = data[offset + 1]!; offset += 2;
      if (marker === 216 || marker === 217 || marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > data.length) break;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break; }
      offset += size;
    }
  } else return undefined;
  if (!width || !height || width > 16000 || height > 16000 || width * height > 40_000_000) throw new Error('图片尺寸无效或超过 4000 万像素');
  if (data.length > 8 * 1024 * 1024) throw new Error('图片超过 8 MB，请压缩后添加');
  return mime;
}

function officeFiles(bytes: Uint8Array) {
  let total = 0, count = 0;
  return unzipSync(bytes, { filter: entry => {
    if (++count > 2000 || entry.originalSize > 16 * 1024 * 1024 || (total += entry.originalSize) > 64 * 1024 * 1024) throw new Error('文档解压内容过大，已停止解析');
    return /^(?:word\/document\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml))$/.test(entry.name);
  } });
}
function xml(bytes: Uint8Array | undefined): any {
  if (!bytes || bytes.length > 8 * 1024 * 1024) throw new Error('文档结构缺失或过大');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new Error('文档包含不支持或无效的 XML 结构');
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true }).parse(text);
}
function richText(node: any): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(richText).join('');
  if (typeof node !== 'object') return '';
  return Object.entries(node).map(([key, value]) => key === 't' ? array(value).map(scalar).join('') : key === 'tab' ? '\t' : key === 'br' ? '\n' : !key.startsWith('@_') ? richText(value) : '').join('');
}
function word(bytes: Uint8Array): DocumentContent {
  const files = officeFiles(bytes), parsed = xml(files['word/document.xml']);
  const paragraphs: NonNullable<DocumentContent['paragraphs']> = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'p') for (const p of array(value) as any[]) {
        const text = richText(p); if (text.trim()) paragraphs.push({ text, heading: /^(?:heading|title)/i.test(p?.pPr?.pStyle?.['@_val'] ?? '') });
      } else visit(value);
    }
  };
  visit(parsed?.document?.body);
  if (!paragraphs.length) throw new Error('Word 文档没有可提取的正文');
  const result: DocumentContent = { format: 'docx', text: paragraphs.map(p => p.text).join('\n\n'), paragraphs, warnings: ['内容预览保留正文顺序，不等同于 Word 原始分页和完整排版。'] };
  return bounded(result);
}
function column(reference: string): number {
  let value = 0;
  for (const c of reference.toUpperCase().match(/^[A-Z]+/)?.[0] ?? '') value = value * 26 + c.charCodeAt(0) - 64;
  return value - 1;
}
function spreadsheet(bytes: Uint8Array): DocumentContent {
  const files = officeFiles(bytes), workbook = xml(files['xl/workbook.xml'])?.workbook;
  const relationships = array(xml(files['xl/_rels/workbook.xml.rels'])?.Relationships?.Relationship) as any[];
  const shared = files['xl/sharedStrings.xml'] ? (array(xml(files['xl/sharedStrings.xml'])?.sst?.si) as any[]).map(richText) : [];
  const styles = files['xl/styles.xml'] ? xml(files['xl/styles.xml'])?.styleSheet : {};
  const formats = new Map((array(styles?.numFmts?.numFmt) as any[]).map(s => [Number(s['@_numFmtId']), String(s['@_formatCode'])]));
  const xfs = array(styles?.cellXfs?.xf) as any[];
  const date1904 = workbook?.workbookPr?.['@_date1904'] === '1' || workbook?.workbookPr?.['@_date1904'] === 'true';
  const specs = array(workbook?.sheets?.sheet) as any[];
  if (!specs.length) throw new Error('表格中没有工作表');
  const warnings = ['显示已保存的单元格值；不执行公式、宏、外部链接或嵌入对象。'];
  let truncated = specs.length > 10, cells = 0, remaining = TEXT_LIMIT;
  const sheets = specs.slice(0, 10).map(sheet => {
    const relationship = relationships.find(r => r['@_Id'] === sheet['@_id']);
    if (!relationship || relationship['@_TargetMode'] === 'External') throw new Error('工作表关系无效或指向外部文件');
    const target = String(relationship['@_Target'] ?? '');
    const file = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target));
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(file)) throw new Error('工作表路径不受支持');
    const rows: string[][] = [];
    const sourceRows = array(xml(files[file])?.worksheet?.sheetData?.row) as any[];
    if (sourceRows.length > 1000) truncated = true;
    for (const row of sourceRows.slice(0, 1000)) {
      const rowIndex = Number(row['@_r'] ?? rows.length + 1) - 1;
      if (!Number.isInteger(rowIndex) || rowIndex < 0) throw new Error('工作表行号无效');
      if (rowIndex >= 1000 || remaining <= 0) { truncated = true; continue; }
      const values: string[] = [];
      for (const cell of array(row.c) as any[]) {
        const index = column(cell['@_r'] ?? '');
        if (index < 0) continue;
        if (index >= 50 || ++cells > 30_000) { truncated = true; continue; }
        let value = scalar(cell.v), type = cell['@_t'];
        if (type === 's') value = shared[Number(value)] ?? '';
        else if (type === 'inlineStr') value = richText(cell.is);
        else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
        else if (value && Number.isFinite(Number(value)) && type !== 'str' && type !== 'e') {
          const formatId = Number(xfs[Number(cell['@_s'] ?? 0)]?.['@_numFmtId'] ?? 0);
          const format = formats.get(formatId)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? '';
          if (formatId >= 14 && formatId <= 22 || /[ymdhis]/i.test(format)) {
            const serial = Number(value), days = date1904 ? serial : serial - (serial >= 60 ? 1 : 0);
            const time = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) + days * 86_400_000);
            if (Number.isFinite(time.valueOf())) value = time.toISOString().replace('T', ' ').replace(/\.000Z$/, '').replace(/ 00:00:00$/, '');
          } else if (formatId === 9 || formatId === 10 || format.includes('%')) value = String(Number((Number(value) * 100).toFixed(6))) + '%';
        }
        const limited = value.slice(0, Math.min(10_000, remaining));
        if (limited.length < value.length) truncated = true;
        remaining -= limited.length;
        while (values.length < index) values.push(''); values[index] = limited;
      }
      while (rows.length <= rowIndex) rows.push([]);
      rows[rowIndex] = values;
    }
    return { name: String(sheet['@_name'] ?? '工作表').slice(0, 120), rows };
  });
  if (truncated) warnings.push('内容已截断：最多 10 个工作表、每表 1000 行、50 列，合计 30000 个单元格和 200000 字符。');
  return bounded({ format: 'xlsx', sheets, truncated, warnings, text: sheets.map(s => '# 工作表：' + s.name + '\n' + s.rows.map(row => row.join('\t')).join('\n')).join('\n\n') });
}
function bounded(result: DocumentContent): DocumentContent {
  if (result.text.length > TEXT_LIMIT) { result.text = result.text.slice(0, TEXT_LIMIT); result.truncated = true; result.warnings.push('提取文字超过 200000 字符，已截断。'); }
  if (result.paragraphs) { let remaining = TEXT_LIMIT; result.paragraphs = result.paragraphs.flatMap(p => { if (!remaining) return []; const text = p.text.slice(0, remaining); remaining -= text.length; return [{ ...p, text }]; }); }
  return result;
}
export async function parseDocument(name: string, bytes: Uint8Array, assetsDir?: string): Promise<DocumentContent> {
  if (bytes.length > DOCUMENT_LIMIT) throw new Error('文档超过 15 MB，请缩小文件后再添加');
  const extension = extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg'].includes(extension)) {
    const mimeType = imageType(bytes); if (!mimeType) throw new Error('图片内容与格式不符，仅支持 PNG 和 JPEG');
    return { format: 'image', mimeType, text: '', warnings: ['图片将发送给所选模型，请选择支持图片理解的模型。'] };
  }
  if (extension === '.docx') return word(bytes);
  if (extension === '.xlsx') return spreadsheet(bytes);
  if (extension === '.pdf') {
    if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件头无效');
    const { default: DOMMatrix } = await import('@thednp/dommatrix');
    (globalThis as any).DOMMatrix ??= DOMMatrix;
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, enableXfa: false, ...(assetsDir ? { cMapUrl: assetsDir + '/cmaps/', cMapPacked: true, standardFontDataUrl: assetsDir + '/standard_fonts/' } : {}) });
    try {
      const pdf = await loading.promise, pages: string[] = [];
      let remaining = TEXT_LIMIT;
      for (let number = 1; number <= Math.min(pdf.numPages, 100); number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent();
        let text = '';
        for (const item of content.items) { if ('str' in item) text += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, remaining - text.length); if (text.length >= remaining) break; }
        pages.push(text.trim()); remaining -= text.length;
        page.cleanup(); if (remaining <= 0) break;
      }
      const warnings: string[] = [];
      if (!pages.some(text => text.trim())) warnings.push('未提取到文字，可能是扫描件。本版不包含 OCR，可查看原页或添加截图。');
      if (pages.length < pdf.numPages) warnings.push('文字提取已达到 100 页或字符上限。');
      return bounded({ format: 'pdf', text: pages.some(page => page.trim()) ? pages.map((page, i) => '第 ' + (i + 1) + ' 页\n' + page).join('\n\n') : '', pages, truncated: pages.length < pdf.numPages || remaining <= 0, warnings });
    } catch (error) { throw new Error((error as Error).name === 'PasswordException' ? 'PDF 已加密，请先解密后添加' : 'PDF 解析失败：' + (error as Error).message); }
    finally { await loading.destroy(); }
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('此文件不是受支持的文档或 UTF-8 文本'); }
  if (text.includes('\0')) throw new Error('此二进制格式暂不支持预览');
  return bounded({ format: 'text', text, warnings: [] });
}
