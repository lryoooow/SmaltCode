import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './icons'
import { cx } from './ui'
import { errorText, store } from '../bridge'
import type { ModelChoice } from './model-choices'

export default function ModelPicker({ value, choices, onChange, disabled, names, onlyProvider, onRefresh, label = '选择模型' }: { value: string; choices: ModelChoice[]; onChange: (id: string) => void; disabled?: boolean; names: Record<string, string>; onlyProvider?: string; onRefresh?: () => Promise<void>; label?: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [provider, setProvider] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), alive = useRef(true), id = useId()
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; height: number }>({ left: 8, top: 48, width: 420, height: 360 })
  const selected = choices.find(m => m.id === value)
  const filtered = choices.filter(m => (!onlyProvider || m.provider === onlyProvider) && (!provider || m.provider === provider) && `${m.label} ${m.id}`.toLowerCase().includes(query.toLowerCase().trim()))
  const visible = filtered.slice(0, 160)
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus() }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = async (force = true) => {
    setLoading(true); setError(undefined)
    try {
      if (onRefresh) await onRefresh()
      else {
        const ids = [...new Set(choices.filter(m => m.configured).map(m => m.provider))].filter(p => provider ? p === provider : !force ? p === selected?.provider : p !== 'ollama' || selected?.provider === 'ollama')
        const results = await Promise.all(ids.map(p => store.loadModels(p, force)))
        const failures = results.map(r => r?.error).filter(Boolean)
        if (alive.current && force && failures.length) setError([...new Set(failures)].join('；'))
      }
    } catch (e) { if (alive.current) setError(errorText(e)) } finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(460, innerWidth - 24)
    const availableAbove = rect.top - 54, availableBelow = innerHeight - rect.bottom - 36
    const height = Math.min(440, Math.max(availableAbove, availableBelow))
    setPosition({ left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)), ...(availableAbove > availableBelow ? { bottom: innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), width, height })
    const timer = setTimeout(() => search.current?.focus(), 0)
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    }
    const resize = () => close()
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', key, true); window.addEventListener('resize', resize)
    if (!onRefresh) void refresh(false)
    return () => { clearTimeout(timer); document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize) }
  }, [open])
  useEffect(() => { if (disabled) close() }, [disabled])
  const navigate = (event: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (event.target === search.current && ['Home', 'End'].includes(event.key)) return
    const options = [...panel.current!.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
    if (!options.length) return
    event.preventDefault(); const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (index + 1) % options.length : (index - 1 + options.length) % options.length
    options[next]?.focus({ preventScroll: true }); options[next]?.scrollIntoView({ block: 'nearest' })
  }
  return <><button ref={trigger} type="button" aria-label={label} aria-expanded={open} aria-controls={id} disabled={disabled} title={value} onClick={() => { setQuery(''); setProvider(''); setOpen(!open) }} className="h-8 max-w-52 min-w-0 px-2 flex items-center gap-1.5 rounded-lg text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-50"><Icon n="cpu" s={14} className="shrink-0" /><span className="truncate">{selected?.label ?? (value.split('/').slice(1).join('/') || '选择模型')}</span><Icon n="down" s={12} className="shrink-0" /></button>
    {open && createPortal(<div ref={panel} id={id} data-testid="model-picker" onKeyDown={navigate} style={{ left: position.left, top: position.top, bottom: position.bottom, width: position.width, maxHeight: position.height }} className="fixed z-[110] flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-[0_12px_40px_-8px_rgba(0,0,0,.25)]">
      <div className="shrink-0 flex items-center gap-2 border-b border-[var(--line)] p-2.5"><Icon n="search" s={15} className="text-[var(--muted)]" /><input ref={search} aria-label="搜索模型" placeholder="搜索名称或模型 ID…" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" /><button aria-label="刷新模型列表" title="从当前已配置服务获取，不发送对话内容" disabled={loading} onClick={() => void refresh()} className="size-7 shrink-0 rounded-md grid place-items-center hover:bg-[var(--hover)] disabled:opacity-50"><Icon n="refresh" s={14} className={loading ? 'spin' : ''} /></button><button aria-label="关闭模型列表" onClick={() => close(true)} className="size-7 rounded-md grid place-items-center hover:bg-[var(--hover)]"><Icon n="x" s={14} /></button></div>
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--line)] text-[11px] text-[var(--muted)]">{!onlyProvider && <select aria-label="筛选模型服务商" value={provider} onChange={e => setProvider(e.target.value)} className="min-w-0 rounded-md bg-[var(--sunken)] p-1"><option value="">所有服务商</option>{[...new Set(choices.map(m => m.provider))].map(id => <option key={id} value={id}>{names[id] ?? id}</option>)}</select>}<span className="ml-auto">{loading ? '正在获取…' : `${filtered.length} 个模型`}</span></div>
      {error && <div role="status" className="shrink-0 max-h-20 overflow-auto px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/5">{error}</div>}
      <div role="listbox" aria-label="可选模型" className="min-h-0 overflow-y-auto overscroll-contain p-1.5">{visible.length ? visible.map(m => <button key={m.id} type="button" role="option" aria-selected={m.id === value} disabled={!!m.disabled} title={m.disabled || m.id} onClick={() => { onChange(m.id); close(true) }} className={cx('w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50', m.id === value && 'bg-[var(--accent-soft)]')}><div className="flex gap-2 items-center"><span className="min-w-0 flex-1 truncate text-[12px] font-medium">{m.label}</span>{m.id === value && <Icon n="check" s={13} className="shrink-0 text-accent" />}<span className="shrink-0 text-[11px] text-[var(--muted)]">{m.source === '容量待确认' ? '容量待确认' : m.window.toLocaleString() + ' Token'}</span></div><div className="mt-0.5 truncate text-[10.5px] text-[var(--muted)]">{names[m.provider] ?? m.provider} · {m.id.slice(m.provider.length + 1)}</div><p className="mt-1 text-[10.5px] text-[var(--muted)] [overflow-wrap:anywhere]">{m.disabled || `${m.source}${m.stale ? ' · 缓存待刷新' : ''}${m.info?.tools ? ' · 工具调用' : ''}${m.info?.vision ? ' · 图片理解' : ''}${m.info?.lifecycle === 'deprecated' ? ' · 即将下线' : ''}`}</p></button>) : <div className="p-6 text-center text-[12px] text-[var(--muted)]">没有匹配模型，可刷新列表或在设置中填写自定义 ID。</div>}{filtered.length > visible.length && <p className="p-2 text-center text-[11px] text-[var(--muted)]">仅展示前 {visible.length} 项，请输入关键词缩小范围。</p>}</div>
      <p className="shrink-0 border-t border-[var(--line)] px-3 py-2 text-[10.5px] text-[var(--muted)]">模型名称来自接口或内置目录；账户权限以服务商实际返回为准。</p>
    </div>, document.body)}</>
}
