import { useEffect, useState } from 'react'
import { errorText, folderName, store, type ContextReference } from '../bridge'
import Icon from './icons'
import { cx } from './ui'

export function ContextTray({ refs, onChange }: { refs: ContextReference[]; onChange: (refs: ContextReference[]) => void }) {
  return refs.length ? <div data-testid="context-references" className="flex flex-wrap gap-1.5 px-3 pt-3">{refs.map((ref, index) => <span key={ref.path + ':' + ref.start + ':' + ref.end} title={ref.path} className="flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-lg bg-[var(--accent-soft)] text-accent border border-accent/15 text-[12px] max-w-full"><Icon n="paperclip" s={13} /><span className="truncate">{ref.label ?? folderName(ref.path)}{ref.start !== undefined && ' · 选区'}</span><button aria-label={'移除引用 ' + (ref.label ?? folderName(ref.path))} onClick={() => onChange(refs.filter((_, i) => i !== index))} className="p-1 rounded hover:bg-[var(--hover)]"><Icon n="x" s={12} /></button></span>)}</div> : null
}
export type Mention = { start: number; end: number; query: string }
export function mentionAt(value: string, end: number): Mention | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, end))
  return match ? { start: value.lastIndexOf('@', end - 1), end, query: match[1] } : undefined
}
export function FileMentions({ ws, mention, onChoose, onClose }: { ws?: string; mention: Mention; onChoose: (path: string) => void; onClose: () => void }) {
  const [matches, setMatches] = useState<string[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string>(), [choice, setChoice] = useState(0)
  useEffect(() => {
    let alive = true; setLoading(true); setError(undefined); setChoice(0)
    const timer = setTimeout(() => { if (!ws) { setLoading(false); return }; void store.api!.searchFiles(ws, mention.query).then(result => { if (alive) setMatches(result.files) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) }) }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [mention.query, ws])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || (e.target as HTMLElement)?.getAttribute('aria-label') !== '任务输入') return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setChoice(i => Math.max(0, Math.min(matches.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))) }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (!loading && matches[choice]) onChoose(matches[choice]) }
    }
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true)
  }, [loading, matches, choice, onChoose, onClose])
  return <div data-testid="file-mentions" role="listbox" aria-label="引用工作区文件" className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-xl p-1.5"><div className="px-2 py-1.5 text-[11px] text-[var(--muted)]">引用文件 · ↑↓ 选择，Enter 添加，Esc 关闭</div>{!ws ? <div className="p-3 text-[var(--muted)]">请先选择工作文件夹</div> : loading ? <div className="p-3 text-[var(--muted)]">正在查找文件…</div> : error ? <div role="alert" className="p-3 text-rose-500">{error}</div> : matches.length ? matches.map((path, index) => <button key={path} role="option" aria-selected={index === choice} onMouseDown={e => e.preventDefault()} onClick={() => onChoose(path)} className={cx('w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left', index === choice ? 'bg-[var(--accent-soft)] text-accent' : 'hover:bg-[var(--hover)]')}><Icon n="file" s={14} /><span className="truncate">{path}</span></button>) : <div className="p-3 text-[var(--muted)]">没有找到匹配文件</div>}</div>
}
