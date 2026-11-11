import { useEffect, useState, type ReactNode } from 'react'
import { errorText, folderName, store, type ContextReference } from '../bridge'
import Icon from './icons'
import { cx } from './ui'

export const VIRTUAL_CONTEXTS = [
  { path: '@git:diff', label: 'Git 改动 (@git:diff)', desc: '引用工作区未提交的 Git 差异快照', icon: 'branch' },
  { path: '@git:status', label: 'Git 状态 (@git:status)', desc: '引用当前分支与变更文件列表', icon: 'branch' },
  { path: '@terminal', label: '最近终端输出 (@terminal)', desc: '引用本对话最近的进程与终端日志', icon: 'terminal' },
] as const

export function ContextTray({ refs, onChange, onPreview, controls }: { controls?: ReactNode; refs: ContextReference[]; onChange: (refs: ContextReference[]) => void; onPreview?: (ref: ContextReference) => void }) {
  return refs.length ? <div data-testid="context-references" className="flex flex-wrap gap-1.5 px-3 pt-3">{refs.map((ref, index) => { const label = (ref.annotation === undefined ? '' : '批注 ' + refs.slice(0, index + 1).filter(value => value.annotation !== undefined).length + ' · ') + (ref.label ?? folderName(ref.path)); const icon = ref.path.startsWith('skill:') ? 'spark' : ref.path === '@terminal' ? 'terminal' : ref.path.startsWith('@git:') ? 'branch' : 'paperclip'; return <span key={ref.path + ':' + ref.start + ':' + ref.end} title={ref.label ?? ref.path} className="flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-lg bg-[var(--accent-soft)] text-accent border border-accent/15 text-[12px] max-w-full"><Icon n={icon} s={13} /><button aria-label={'预览引用 ' + label} onClick={() => onPreview?.(ref)} className="truncate hover:underline">{label}{ref.path.startsWith('source:')&&' · 只读'}{ref.path.startsWith('attachment:')&&' · 副本'}{ref.start !== undefined && ' · 选区'}</button><button aria-label={'移除引用 ' + label} onClick={() => onChange(refs.filter((_, i) => i !== index))} className="p-1 rounded hover:bg-[var(--hover)]"><Icon n="x" s={12} /></button></span> })}{controls}</div> : null
}
export type Mention = { start: number; end: number; query: string }
export function mentionAt(value: string, end: number): Mention | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, end))
  return match ? { start: value.lastIndexOf('@', end - 1), end, query: match[1] } : undefined
}
export function FileMentions({ ws, mention, onChoose, onClose }: { ws?: string; mention: Mention; onChoose: (path: string) => void; onClose: () => void }) {
  const [matches, setMatches] = useState<string[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string>(), [choice, setChoice] = useState(0)
  const q = mention.query.toLowerCase()
  const virtualMatches = VIRTUAL_CONTEXTS.filter(v => !q || v.path.slice(1).includes(q) || v.label.toLowerCase().includes(q))
  const options = [...virtualMatches.map(v => ({ path: v.path, label: v.label, desc: v.desc, icon: v.icon })), ...matches.map(path => ({ path, label: path, desc: '', icon: 'file' }))]
  useEffect(() => {
    let alive = true; setLoading(true); setError(undefined); setChoice(0)
    const timer = setTimeout(() => { if (!ws || !store.api?.searchFiles) { setMatches([]); setLoading(false); return }; void store.api.searchFiles(ws, mention.query).then(result => { if (alive) setMatches(result.files) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) }) }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [mention.query, ws])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || (e.target as HTMLElement)?.getAttribute('aria-label') !== '任务输入') return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setChoice(i => Math.max(0, Math.min(Math.max(0, options.length - 1), i + (e.key === 'ArrowDown' ? 1 : -1)))) }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (options[choice]) onChoose(options[choice].path) }
    }
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true)
  }, [options, choice, onChoose, onClose])
  return <div data-testid="file-mentions" role="listbox" aria-label="引用工作区文件" className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-xl p-1.5"><div className="px-2 py-1.5 text-[11px] text-[var(--muted)]">引用上下文与文件 · ↑↓ 选择，Enter 添加，Esc 关闭</div>{!ws ? <div className="p-3 text-[var(--muted)]">正在准备本地对话空间…</div> : options.length ? <>{options.map((opt, index) => <button key={opt.path} role="option" aria-selected={index === choice} onMouseDown={e => e.preventDefault()} onClick={() => onChoose(opt.path)} className={cx('w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left', index === choice ? 'bg-[var(--accent-soft)] text-accent' : 'hover:bg-[var(--hover)]')}><Icon n={opt.icon} s={14} /><span className="truncate font-medium">{opt.label}</span>{opt.desc && <span className="ml-auto text-[11px] text-[var(--muted)] truncate max-w-48">{opt.desc}</span>}</button>)}{loading && <div className="px-2.5 py-1.5 text-[11px] text-[var(--muted)]">正在查找工作区文件…</div>}</> : loading ? <div className="p-3 text-[var(--muted)]">正在查找文件…</div> : error ? <div role="alert" className="p-3 text-rose-500">{error}</div> : <div className="p-3 text-[var(--muted)]">没有找到匹配文件</div>}</div>
}
