import { extname, resolve, relative, isAbsolute } from 'node:path';
import { isInsideWorkspace, isSensitivePath } from '@smalt/kernel';

/** Browser grants cover one exact origin, never arbitrary URL schemes or LAN names. */
export function browserURL(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new Error('请输入完整的 HTTPS 或本机开发地址');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error('仅支持 HTTPS 或 localhost / 127.0.0.1 / [::1] 的 HTTP 开发页');
  if (!loopback && (/^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.') || /\.(?:local|localhost|internal|lan)$/i.test(url.hostname))) throw new Error('远程页面不能访问局域网地址');
  return url;
}
export function browserRequestAllowed(value: string, origin: string): boolean {
  try {
    const url = new URL(value), grant = new URL(origin);
    if (url.username || url.password) return false;
    if (url.protocol === 'ws:' || url.protocol === 'wss:') { url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'; }
    return url.protocol === grant.protocol && url.host === grant.host && ['http:', 'https:', 'smalt-preview:'].includes(url.protocol);
  } catch { return false; }
}
const mime: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
export function localPreviewAsset(cwd: string, root: string, pathname: string) {
  const decoded = decodeURIComponent(pathname);
  if (/[\\:\x00-\x1f]/.test(decoded) || decoded.split('/').some(part => part.startsWith('.'))) throw new Error('不允许的预览路径');
  const path = resolve(root, '.' + decoded), rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isInsideWorkspace(root, path) || !isInsideWorkspace(cwd, path) || isSensitivePath(cwd, path)) throw new Error('预览资源超出允许目录');
  const contentType = mime[extname(path).toLowerCase()];
  if (!contentType) throw new Error('此资源格式不在静态预览范围内');
  return { path, contentType };
}
export function imageRegion(value: unknown) {
  const v = value as { x: number; y: number; width: number; height: number };
  if (!v || ![v.x, v.y, v.width, v.height].every(n => typeof n === 'number' && Number.isFinite(n)) || v.x < 0 || v.y < 0 || v.width <= 0 || v.height <= 0 || v.x + v.width > 1.00001 || v.y + v.height > 1.00001) throw new Error('无效的图片区域');
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}
export function browserCSP(sources: string[]) {
  const origins = sources.map(value => browserURL(value).origin).join(' ');
  return `default-src 'self' ${origins}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${origins}; style-src 'self' 'unsafe-inline' ${origins}; img-src 'self' data: blob: ${origins}; font-src 'self' data: ${origins}; connect-src 'self' ${origins}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'`;
}
