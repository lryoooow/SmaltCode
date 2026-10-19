import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { imageType, parseDocument } from '../src/main/document-parser.js';

const pack = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vCEAAAAASUVORK5CYII=', 'base64');
describe('bounded document parsing', () => {
  it('reads Word text, escaped markup and heading metadata without rendering HTML', async () => {
    const bytes = pack({ 'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文标题</w:t></w:r></w:p><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; &amp; 原文</w:t></w:r></w:p></w:body></w:document>' });
    const result = await parseDocument('meeting.docx', bytes);
    expect(result.format).toBe('docx'); expect(result.paragraphs?.[0]).toEqual({ text: '中文标题', heading: true });
    expect(result.text).toContain('<script>alert(1)</script> & 原文');
    expect(result.warnings[0]).toContain('不等同');
  });
  it('reads sheet names, sparse cells, cached formulas, dates and strings', async () => {
    const bytes = pack({
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="数据 &amp; 汇总" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>中文资料</t></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>HYPERLINK("https://evil.invalid")</f><v>42</v></c></row><row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2" t="inlineStr"><is><t>&lt;img src=x&gt;</t></is></c></row></sheetData></worksheet>',
    });
    const result = await parseDocument('book.xlsx', bytes);
    expect(result.sheets?.[0]?.name).toBe('数据 & 汇总');
    expect(result.sheets?.[0]?.rows[0]).toEqual(['中文资料', '', '42']);
    expect(result.sheets?.[0]?.rows[1]).toEqual(['2024-01-01', '<img src=x>']);
    expect(result.text).not.toContain('evil.invalid');
  });
  it('rejects XML entities, external sheet relations, zip expansion and invalid files', async () => {
    await expect(parseDocument('evil.docx', pack({ 'word/document.xml': '<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///secret">]><doc>&x;</doc>' }))).rejects.toThrow('XML');
    await expect(parseDocument('evil.xlsx', pack({ 'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="A" r:id="a"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="a" TargetMode="External" Target="https://evil.invalid/a"/></Relationships>' }))).rejects.toThrow('外部');
    await expect(parseDocument('large.docx', pack({ 'word/document.xml': 'a'.repeat(17 * 1024 * 1024) }))).rejects.toThrow('解压');
    await expect(parseDocument('broken.pdf', strToU8('not pdf'))).rejects.toThrow('文件头');
    await expect(parseDocument('script.png', strToU8('<svg onload="alert(1)"/>'))).rejects.toThrow('格式');
  });
  it('recognizes safe screenshots and bounds decompressed image dimensions', async () => {
    expect(imageType(png)).toBe('image/png'); expect((await parseDocument('截图.png', png)).format).toBe('image');
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16);
    expect(() => imageType(bomb)).toThrow('4000 万');
  });
  it('preserves actual spreadsheet row numbers and bounds repeated shared text', async () => {
    const files = {
      'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="数据" r:id="a"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>' + 'x'.repeat(10000) + '</t></si></sst>',
      'xl/worksheets/a.xml': '<worksheet><sheetData><row r="3"><c r="A3"><v>42</v></c></row>' + Array.from({ length: 30 }, (_, i) => '<row r="' + (i + 4) + '"><c r="A' + (i + 4) + '" t="s"><v>0</v></c></row>').join('') + '</sheetData></worksheet>',
    };
    const result = await parseDocument('bounded.xlsx', pack(files));
    expect(result.sheets?.[0]?.rows.slice(0, 3)).toEqual([[], [], ['42']]);
    expect(JSON.stringify(result.sheets).length).toBeLessThan(201000);
    expect(result.truncated).toBe(true);
  });
});
