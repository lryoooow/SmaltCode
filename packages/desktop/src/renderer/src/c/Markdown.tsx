import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { errorText, store } from '../bridge'
function Markdown({ text }: { text: string }) {
  const [copied, setCopied] = useState<string>()
  return <div className="markdown break-words"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ children }) => <pre className="relative">{children}</pre>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    a: ({ href, children }) => <button className="text-accent underline underline-offset-2" title={href} onClick={() => {
      if (!href) return
      void navigator.clipboard.writeText(href).then(() => setCopied('链接已复制')).catch(err => setCopied(errorText(err)))
    }}>{children}</button>,
    img: ({ alt }) => <span className="text-[var(--muted)]">[图片：{alt || '模型引用的图片'}]</span>,
  }}>{text}</ReactMarkdown>{copied && <span role="status" className="text-[11px] text-[var(--muted)]">{copied}</span>}</div>
}
export default memo(Markdown)
