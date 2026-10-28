import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { errorText } from '../bridge'
import Icon from './icons'
import { sourceLink } from './source-link'
function Markdown({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => Promise<void> | void }) {
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const [opening, setOpening] = useState(false)
  const mounted = useRef(true), pending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const copy = async (href: string, hint?: string) => {
    try { await navigator.clipboard.writeText(href); if (mounted.current) setNotice({ text: hint ? hint + ' 链接已复制。' : '链接已复制。' }) }
    catch (error) { if (mounted.current) setNotice({ text: '无法复制链接：' + errorText(error), error: true }) }
  }
  const open = async (url: string) => {
    if (!onOpenLink || pending.current) return
    pending.current = true; setOpening(true); setNotice({ text: '正在隔离浏览中打开来源…' })
    try { await onOpenLink(url); if (mounted.current) setNotice({ text: '来源已在浏览预览中打开。' }) }
    catch (error) { if (mounted.current) setNotice({ text: '无法打开来源：' + errorText(error), error: true }) }
    finally { pending.current = false; if (mounted.current) setOpening(false) }
  }
  return <div className="markdown break-words"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ children }) => <pre className="relative">{children}</pre>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    a: ({ href, children }) => {
      const target = sourceLink(href)
      return target.url && onOpenLink ? <span className="inline"><a data-testid="source-link" data-source-url={target.url} href={target.url} title={href} aria-disabled={opening || undefined} className="text-accent underline underline-offset-2" onClick={event => { event.preventDefault(); void open(target.url) }}>{children}</a><button type="button" data-testid="source-copy-link" aria-label="复制链接" title={'复制链接 · ' + href} onClick={() => void copy(href!)} className="inline-flex align-middle ml-0.5 p-0.5 rounded text-[var(--muted)] hover:text-accent hover:bg-[var(--hover)]"><Icon n="copy" s={12} /></button></span>
        : <button type="button" data-testid="markdown-copy-link" disabled={!href} className="text-accent underline underline-offset-2 disabled:text-[var(--muted)]" title={href ? href + ' · ' + (onOpenLink && target.reason ? target.reason : '点击复制链接') : '此链接无法预览'} onClick={() => href && void copy(href, onOpenLink ? target.reason : undefined)}>{children}<Icon n="copy" s={11} className="inline align-middle ml-0.5 opacity-60" /></button>
    },
    img: ({ alt }) => <span className="text-[var(--muted)]">[图片：{alt || '模型引用的图片'}]</span>,
  }}>{text}</ReactMarkdown>{notice && <p data-testid="source-link-status" role={notice.error ? 'alert' : 'status'} className={notice.error ? 'mt-2 text-[11px] text-rose-700 dark:text-rose-300' : 'mt-2 text-[11px] text-[var(--muted)]'}>{notice.text}</p>}</div>
}
export default memo(Markdown)
