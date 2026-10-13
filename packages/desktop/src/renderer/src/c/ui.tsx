import { useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from './icons'
import { createPortal } from 'react-dom'

export type Status = 'running' | 'approval' | 'question' | 'unread' | 'failed' | 'stopped' | 'done'
export type Task = { id: string; title: string; ws: string; status: Status; time: string; group: string; pinned?: boolean; projectId?: string }

export const cx = (...a: (string | false | undefined | null)[]) => a.filter(Boolean).join(' ')

export function Btn({ children, v = 'ghost', className = '', ...p }: { v?: 'primary' | 'ghost' | 'outline' | 'danger' | 'soft' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const vs = {
    primary: 'bg-accent text-white hover:brightness-110 shadow-[0_1px_0_rgba(255,255,255,.25)_inset,0_2px_8px_-2px_rgba(47,79,208,.5)]',
    ghost: 'hover:bg-[var(--hover)] text-[var(--text)]',
    outline: 'border border-[var(--line)] bg-[var(--surface-solid)] hover:bg-[var(--sunken)]',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
    soft: 'bg-[var(--accent-soft)] text-accent dark:text-indigo-200 hover:brightness-95',
  }
  return (
    <button {...p} className={cx('inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium transition-all duration-150 active:scale-[.97] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent', vs[v], className)}>
      {children}
    </button>
  )
}

export function IconBtn({ n, label, onClick, active, className = '' }: { n: string; label: string; onClick?: () => void; active?: boolean; className?: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx('group relative grid place-items-center size-7 rounded-md text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition active:scale-90', active && 'text-[var(--text)] bg-[var(--hover)]', className)}>
      <Icon n={n} s={16} />
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="px-1.5 h-5 inline-grid place-items-center rounded border border-[var(--line)] bg-[var(--sunken)] text-[10.5px] font-mono text-[var(--muted)]">{children}</kbd>
}

export function StatusDot({ s }: { s: Status }) {
  if (s === 'running') return <span className="size-3.5 grid place-items-center"><span className="size-3 rounded-full border-[1.5px] border-accent border-t-transparent spin" /></span>
  if (s === 'approval' || s === 'question') return <span className="size-3.5 grid place-items-center"><span className="size-2 rounded-full bg-amber-500 pulse-ring" /></span>
  if (s === 'unread') return <span className="size-3.5 grid place-items-center"><span className="size-2 rounded-full bg-accent" /></span>
  if (s === 'failed') return <span className="size-3.5 grid place-items-center text-rose-500"><Icon n="alert" s={13} /></span>
  if (s === 'stopped') return <span className="size-3.5 grid place-items-center"><span className="size-2 rounded-[2px] bg-[var(--muted)] opacity-60" /></span>
  return <span className="size-3.5" />
}

export function Menu({ trigger, items, align = 'left', up }: { trigger: (o: boolean) => ReactNode; items: { label: string; icon?: string; hint?: string; danger?: boolean; disabled?: boolean; onClick?: () => void; sel?: boolean; desc?: string }[]; align?: 'left' | 'right'; up?: boolean }) {
  const [o, setO] = useState(false)
  const r = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, bottom: undefined as number | undefined })
  useEffect(() => {
    const h = (e: MouseEvent) => !r.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setO(false)
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setO(false) }
    document.addEventListener('mousedown', h); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', key) }
  }, [])
  useEffect(() => {
    if (!o || !r.current) return
    const rect = r.current.getBoundingClientRect()
    const estimatedHeight = Math.min(420, items.length * 42 + 12)
    const above = up || (rect.bottom + estimatedHeight > innerHeight - 12 && rect.top > innerHeight / 2)
    setPosition({ left: Math.max(8, Math.min(innerWidth - 248, align === 'right' ? rect.right - 240 : rect.left)), top: above ? 0 : rect.bottom + 6, bottom: above ? innerHeight - rect.top + 6 : undefined })
    const close = () => setO(false)
    addEventListener('resize', close)
    return () => removeEventListener('resize', close)
  }, [o, align, up])
  return (
    <div ref={r} className="relative inline-flex">
      <span onClick={e => { if (!(e.target as Element).closest('button:disabled')) setO(!o) }}>{trigger(o)}</span>
      {o && createPortal(
        <div ref={menu} role="menu" style={{ left: position.left, top: position.bottom === undefined ? position.top : undefined, bottom: position.bottom, maxHeight: position.bottom === undefined ? Math.max(120, innerHeight - position.top - 12) : Math.max(120, innerHeight - position.bottom - 12) }} className="fixed z-[100] w-60 overflow-y-auto p-1 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-[0_12px_40px_-8px_rgba(0,0,0,.25)] anim-pop">
          {items.map((it, i) => it.label === '-' ? <div key={i} className="h-px my-1 bg-[var(--line)]" /> : (
            <button key={i} disabled={it.disabled} onClick={() => { it.onClick?.(); setO(false) }} className={cx('w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--hover)] transition disabled:opacity-40', it.danger && 'text-rose-500')}>
              {it.icon && <Icon n={it.icon} s={15} className="mt-0.5 text-[var(--muted)]" />}
              <span className="flex-1"><span className="block">{it.label}</span>{it.desc && <span className="block text-[11.5px] text-[var(--muted)]">{it.desc}</span>}</span>
              {it.sel && <Icon n="check" s={14} className="mt-0.5 text-accent" />}
              {it.hint && <span className="text-[11px] text-[var(--muted)] mt-0.5">{it.hint}</span>}
            </button>
          ))}
        </div>, document.body
      )}
    </div>
  )
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={cx('relative w-9 h-5 rounded-full transition-colors', on ? 'bg-accent' : 'bg-[var(--line)]')}>
      <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200', on && 'translate-x-4')} />
    </button>
  )
}

export function Logo({ s = 22 }: { s?: number }) {
  return <img src="./smalt.svg" width={s} height={s} alt="SmaltCode" draggable={false} className="shrink-0 drop-shadow-[0_2px_4px_rgba(47,79,208,.25)]" />
}

export const MODES = [
  { id: 'default', label: '敏感操作先问', desc: '读写前对敏感操作请求确认', icon: 'shield' },
  { id: 'plan', label: '计划模式', desc: '只读，不修改任何文件', icon: 'eye' },
  { id: 'acceptEdits', label: '自动接受编辑', desc: '文件修改无需确认，命令仍需确认', icon: 'file' },
  { id: 'dontAsk', label: '不询问', desc: '未预先允许的操作一律拒绝', icon: 'lock' },
  { id: 'bypassPermissions', label: '跳过审批', desc: '高风险 · 操作无需逐次确认', icon: 'alert', danger: true },
]
export const MODELS = ['DeepSeek-V3.2', 'GLM-4.6', 'Kimi-K2', 'Qwen3-Max', 'Claude Sonnet 4.5']
