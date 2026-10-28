export type SourceLink = { url: string; reason?: never } | { url?: never; reason: string }

/** A UI affordance only: BrowserManager still checks DNS, origin consent and every request. */
export function sourceLink(value: unknown): SourceLink {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return { reason: '此链接不是可预览的完整网页地址。' }
  let url: URL
  try { url = new URL(value) } catch { return { reason: '相对地址无法直接预览，请复制后核对完整来源。' } }
  if (url.protocol === 'http:') return { reason: 'HTTP 来源不支持隔离预览，请复制链接后自行核对。' }
  if (url.protocol !== 'https:') return { reason: '此链接类型不支持网页预览。' }
  if (url.username || url.password || url.port && url.port !== '443') return { reason: '带账号信息或非标准端口的链接不能直接预览。' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host) || host.length > 253 || host.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return { reason: '本机、局域网或保留地址不能从来源链接中直接预览。' }
  for (const name of url.searchParams.keys()) if (/^(?:(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|auth|credential|signature|sig|key|sas|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/i.test(name)) return { reason: '含凭据或签名参数的链接不能直接预览。' }
  return { url: url.href }
}
