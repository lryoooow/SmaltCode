import { useEffect, useId, useRef, useState } from 'react'
import type { Item, ThreadStatus } from '../bridge'
import { planProgress, type activityProgress } from './activity'
import Icon from './icons'
import { cx } from './ui'

type Plan = Extract<Item, { kind: 'plan' }>
type Progress = ReturnType<typeof activityProgress>

function PlanSteps({ plan, running = false }: { plan: Plan; running?: boolean }) {
  return <ol className="space-y-1 p-2" data-testid="plan-steps">
    {plan.steps.map((step, i) => <li key={i} data-testid="plan-step" aria-current={step.status === 'inProgress' ? 'step' : undefined} className={cx('flex items-start gap-2.5 rounded-lg px-2.5 py-2', step.status === 'inProgress' && 'bg-[var(--accent-soft)]')}>
      <span className={cx('mt-0.5 size-4 shrink-0 rounded-full grid place-items-center text-[10px] tabular-nums', step.status === 'completed' ? 'bg-accent text-white' : step.status === 'inProgress' ? 'border-[1.5px] border-accent text-accent' : 'border border-[var(--line)] text-[var(--muted)]')}>{step.status === 'completed' ? <Icon n="check" s={10} w={2.4} /> : i + 1}</span>
      <div className="min-w-0 flex-1"><p className={cx('text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', step.status === 'completed' ? 'text-[var(--muted)]' : step.status === 'inProgress' && 'font-medium')}>{step.content}</p>{step.status === 'inProgress' && <span className="text-[10.5px] text-accent">{running ? '当前步骤' : '待继续'}</span>}</div>
    </li>)}
  </ol>
}

/** Non-modal, anchored above the composer. Never takes over conversation scroll. */
export default function TaskProgress({ plan, progress, running, lifecycle, interrupted, error, onOpenChange, idleLabel, issueLabel, onInspectIssues }: {
  plan?: Plan; progress: Progress; running: boolean; lifecycle?: ThreadStatus['lifecycle']; interrupted?: boolean; error?: string
  onOpenChange: (open: boolean) => void
  idleLabel: string; issueLabel: string; onInspectIssues: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const info = plan ? planProgress(plan) : undefined
  const waiting = lifecycle === 'waitingForPermission' || lifecycle === 'waitingForUser'
  const label = running ? progress.label : interrupted ? '已停止，可继续任务' : error ? '任务已暂停' : idleLabel
  const current = info?.current?.content
  useEffect(() => { if (!plan) setOpen(false) }, [!!plan])
  useEffect(() => { onOpenChange(open); return () => onOpenChange(false) }, [open, onOpenChange])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return
      const returnFocus = event.target instanceof Node && root.current?.contains(event.target)
      setOpen(false)
      if (returnFocus) { event.preventDefault(); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key) }
  }, [open])
  return <div ref={root} data-testid="task-progress-dock" className="relative z-30 mb-2 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-[0_4px_18px_-10px_rgba(0,0,0,.2)]">
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center', waiting || error || interrupted || issueLabel ? 'text-amber-600 dark:text-amber-300' : 'text-accent')}><Icon n={waiting ? 'shield' : interrupted ? 'stop' : error || issueLabel ? 'alert' : info?.complete && !running ? 'check' : 'list'} s={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0 text-[12px] leading-5"><span role="status" aria-live="polite" data-testid="task-progress" className="font-medium shrink-0">{label}</span>{running && progress.detail && <span data-testid="progress-subject" title={progress.detail} className="truncate text-[var(--muted)]">· {progress.detail}</span>}</div>
        {current ? <p data-testid="current-plan-step" title={current} className="truncate text-[11.5px] leading-5 text-[var(--muted)]">{running ? '当前计划' : '待继续'} · 第 {info!.index + 1} 步：{current}</p> : progress.recent ? <p data-testid="progress-checkpoint" title={progress.recent} className="truncate text-[11.5px] leading-5 text-[var(--muted)]">{progress.recent}</p> : null}
        {current && progress.milestones.length > 0 && <p data-testid="progress-milestones" title={progress.milestones.join(' · ')} className="truncate text-[11px] leading-5 text-[var(--muted)]">{progress.milestones.join(' · ')}</p>}
      </div>
      {plan && <button ref={trigger} data-testid="plan-toggle" aria-label={open ? '收起执行计划' : '展开执行计划'} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)} className="mt-0.5 shrink-0 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-accent"><span>计划</span><span className="tabular-nums text-[var(--muted)]" aria-label={`已完成 ${info!.done} / ${info!.total} 步`}>{info!.done}/{info!.total}</span><Icon n="chevron" s={12} className={cx('transition-transform', open ? 'rotate-90' : '-rotate-90')} /></button>}
    </div>
    {(issueLabel || error) && <div data-testid="failure-overview" className="flex items-center gap-2 border-t border-[var(--line)] px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-300"><Icon n="alert" s={12} className="shrink-0" /><span className="min-w-0 flex-1 truncate" title={issueLabel || error}>{issueLabel || '查看任务暂停的具体原因'}</span><button onClick={onInspectIssues} className="shrink-0 text-[var(--accent)] hover:underline">查看原因</button></div>}
    {plan && <div role="progressbar" aria-label="计划已完成步骤" aria-valuemin={0} aria-valuemax={info!.total} aria-valuenow={info!.done} className="h-0.5 overflow-hidden rounded-b-xl bg-[var(--sunken)]"><div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${info!.done / info!.total * 100}%` }} /></div>}
    {open && plan && <section id={panelId} role="region" aria-label="执行计划详情" data-testid="plan-popover" className="absolute bottom-full left-0 right-0 mb-2 flex max-h-[min(44vh,320px)] flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-[0_12px_40px_-10px_rgba(0,0,0,.25)]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-3.5 py-2.5"><span className="text-[12px] font-medium">执行计划</span><span className="text-[11px] text-[var(--muted)]">已完成 {info!.done} / {info!.total}</span></div>
      <div tabIndex={0} aria-label="计划步骤列表" className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"><PlanSteps plan={plan} running={running} /></div>
    </section>}
  </div>
}

/** Keep the final snapshot of older turns available outside execution details. */
export function PlanHistory({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false), id = useId(), info = planProgress(plan)
  return <section data-testid="plan-history" className="rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]">
    <button aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12px] hover:bg-[var(--hover)]"><Icon n="list" s={14} className="text-[var(--muted)]" /><span>本轮执行计划</span><span className="ml-auto tabular-nums text-[var(--muted)]">已完成 {info.done}/{info.total}</span><Icon n="chevron" s={12} className={cx('text-[var(--muted)]', open && 'rotate-90')} /></button>
    {open && <div id={id} className="max-h-72 overflow-auto border-t border-[var(--line)]"><PlanSteps plan={plan} /></div>}
  </section>
}
