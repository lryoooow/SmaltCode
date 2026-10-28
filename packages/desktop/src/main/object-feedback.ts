import { nativeImage } from 'electron';
import { imageRegion } from './browser-policy.js';
import type { DocumentPreview } from '../shared/documents.js';
import type { ObjectSelection } from '../shared/browser.js';
import type { FeedbackStore } from './feedback.js';
import type { ImagePart } from '../../../kernel/src/models/types.js';

export async function captureObject(store: FeedbackStore, cwd: string, value: Record<string, unknown>, read: (path: string) => Promise<DocumentPreview>) {
  if (typeof value.path !== 'string' || typeof value.digest !== 'string' || typeof value.note !== 'string' || value.note.length > 2000) throw new Error('无效的局部反馈');
  const file = await read(value.path), region = value.selection as ObjectSelection;
  if (!region || file.digest !== value.digest) throw new Error('来源文件已变化，请刷新后重新选择');
  let text: string, image: ImagePart | undefined;
  if (region.kind === 'image' && file.format === 'image' && file.dataUrl) {
    const rect = imageRegion(region), source = nativeImage.createFromDataURL(file.dataUrl), size = source.getSize();
    if (source.isEmpty() || size.width * size.height > 40_000_000) throw new Error('图片解码失败或像素过大');
    const x = Math.floor(size.width * rect.x), y = Math.floor(size.height * rect.y);
    let crop = source.crop({ x, y, width: Math.max(1, Math.min(size.width - x, Math.ceil(size.width * rect.width))), height: Math.max(1, Math.min(size.height - y, Math.ceil(size.height * rect.height))) });
    const scale = Math.min(1, 1600 / crop.getSize().width, 1600 / crop.getSize().height);
    if (scale < 1) crop = crop.resize({ width: Math.max(1, Math.round(crop.getSize().width * scale)), height: Math.max(1, Math.round(crop.getSize().height * scale)) });
    image = { type: 'image', mimeType: 'image/png', dataBase64: crop.toPNG().toString('base64') };
    text = JSON.stringify({ source: value.path, digest: file.digest, imageSize: size, region: rect, note: value.note, capturedAt: new Date().toISOString() });
  } else if (region.kind === 'cells' && file.format === 'xlsx') {
    const indexes = [region.sheet, region.row, region.column, region.endRow, region.endColumn], sheet = file.sheets?.[region.sheet];
    if (!indexes.every(n => Number.isSafeInteger(n) && n >= 0) || !sheet || region.endRow < region.row || region.endColumn < region.column || region.endRow >= sheet.rows.length || region.endColumn >= Math.max(1, ...sheet.rows.map(row => row.length)) || (region.endRow - region.row + 1) * (region.endColumn - region.column + 1) > 400) throw new Error('请在同一工作表中选择最多 400 个有效单元格');
    text = JSON.stringify({ source: value.path, digest: file.digest, sheet: sheet.name, range: { row: region.row + 1, column: region.column + 1, endRow: region.endRow + 1, endColumn: region.endColumn + 1 }, values: sheet.rows.slice(region.row, region.endRow + 1).map(row => row.slice(region.column, region.endColumn + 1)), note: value.note, capturedAt: new Date().toISOString() });
  } else throw new Error('此对象不支持局部反馈');
  return store.add({ cwd, label: (region.kind === 'image' ? '图片区域 · ' : '单元格 · ') + (value.path.split(/[\\/]/).pop() ?? '对象'), source: value.path, filePath: value.path, fileDigest: file.digest, text, image });
}
