import assets from 'smalt-pdf-assets'

function bytes(key: string) {
  if (!Object.hasOwn(assets, key) || typeof assets[key] !== 'string') throw new Error('PDF 使用了暂不支持的字体资源：' + key.slice(0, 100))
  const raw = atob(assets[key]!), result = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) result[index] = raw.charCodeAt(index)
  return result
}
export class LocalBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    if (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl') throw new Error('PDF 请求了不支持的资源类型')
    return bytes((kind === 'cMapUrl' ? 'cmaps/' : 'standard_fonts/') + filename)
  }
}
