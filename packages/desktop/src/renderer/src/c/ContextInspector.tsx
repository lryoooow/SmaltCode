import { useEffect, useRef, useState } from 'react'
import { errorText, store, type ContextReference } from '../bridge'
import type { ContextCheck } from '../../../shared/context'
import Popover from './Popover'
import { Btn } from './ui'
import Icon from './icons'

export default function ContextInspector({ refs, ws, fileScope, onChange, onPreview }: { refs: ContextReference[]; ws?: string; fileScope?:string; onChange: (refs: ContextReference[]) => void; onPreview: (ref: ContextReference) => void }) {
  const [open, setOpen] = useState(false), [check, setCheck] = useState<ContextCheck>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [refresh, setRefresh] = useState(0)
  const anchor = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open || !ws) return
    let alive = true; setBusy(true); setError(undefined); setCheck(undefined)
    void store.api!.inspectContext(ws, refs,fileScope).then(result => { if (alive) setCheck(result) }).catch(error => { if (alive) setError(errorText(error)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [open, ws, refs, refresh,fileScope])
  if (!refs.length) return null
  return <div className="inline-flex items-center"><button ref={anchor} data-testid="context-check-toggle" className="status-action" aria-expanded={open} onClick={() => setOpen(!open)}><Icon n="eye" s={14} />检查引用</button>{open && <Popover anchor={anchor} above width={500} label="本次上下文检查" onClose={() => setOpen(false)}><div data-testid="context-inspector" className="p-3 space-y-3"><div className="flex items-center gap-2"><h2 className="font-medium flex-1">本次引用资料</h2><Btn disabled={busy} onClick={() => setRefresh(value => value + 1)}>重新检查</Btn></div><p className="text-[12px] text-[var(--muted)]">这里检查本次消息的显式引用；不包含全部历史、系统提示或模型内部信息。发送前还会再次校验。整份文本最多引用前 24000 字符。</p>{busy && <p role="status">正在核对来源与版本…</p>}{error && <p role="alert" className="text-rose-500 break-words">{error}</p>}{check?.error && <p role="alert" className="text-rose-500 break-words">{check.error}</p>}{check?.entries.map((entry, index) => {
    const ref = refs[index]; if (!ref) return null
    const changed = !!ref.digest && !!entry.digest && ref.digest !== entry.digest
    return <article key={index} className="border-t border-[var(--line)] pt-3 space-y-2" data-testid="context-inspection-entry"><div className="text-[13px] font-medium break-words">{entry.label}</div><p className="text-[12px] text-[var(--muted)] break-all">{({ source:'只读原文件资料', ssh: 'SSH 只读资料', workspace: '工作区文件', attachment: '本机附件副本', skill: '已启用技能', feedback: '用户选择的只读快照', memory: '用户保存的范围记忆' })[entry.kind]} · {entry.source || entry.path}</p><p className="text-[12px]">{entry.selected ? `文本选区${entry.startLine ? ` · L${entry.startLine}–L${entry.endLine}` : ''}` : entry.format === 'image' ? '整张图片 · 通过图片通道发送' : entry.truncated ? '前 24000 字符 · 已截断' : '全部可提取文字'}{entry.characters !== undefined && entry.format !== 'image' ? ` · ${entry.characters.toLocaleString()} 字符` : ''}</p>{entry.digest && <p className="text-[12px] text-[var(--muted)]">当前版本 {entry.digest.slice(0, 12)}{ref.digest === entry.digest ? ' · 已固定引用版本' : !ref.digest ? ' · 发送时读取最新内容' : ''}</p>}{entry.error && <p role="alert" className="text-[12px] text-rose-500 break-words">{entry.error}</p>}{entry.warnings.map((warning, i) => <p key={i} className="text-[12px] text-amber-600">{warning}</p>)}{entry.excerpt && <details><summary className="cursor-pointer text-[12px] text-accent">查看引用文字预览{entry.characters! > 3200 ? '（前 3200 字符）' : ''}</summary><pre className="mt-2 text-[12px] whitespace-pre-wrap break-words max-h-44 overflow-auto">{entry.excerpt}</pre></details>}<div className="flex flex-wrap gap-2"><Btn onClick={() => { setOpen(false); onPreview(ref) }}>打开来源</Btn>{entry.digest && !entry.selected && entry.kind !== 'attachment' && entry.kind !== 'feedback' && entry.kind !== 'memory' && (changed || !ref.digest) && <Btn onClick={() => onChange(refs.map((value, i) => i === index ? { ...value, digest: entry.digest } : value))}>{changed ? '采用当前版本' : '固定当前版本'}</Btn>}<Btn onClick={() => onChange(refs.filter((_, i) => i !== index))}>移除引用</Btn></div></article>
  })}{check && <p className="text-[11px] text-[var(--muted)]">检查时间 {new Date(check.checkedAt).toLocaleTimeString()} · 文件仍可能在检查后变化</p>}</div></Popover>}</div>
}
