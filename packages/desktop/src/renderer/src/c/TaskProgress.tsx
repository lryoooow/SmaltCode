import { useEffect, useRef, useState } from 'react'
import type { Item, ThreadStatus } from '../bridge'
import { planProgress, type activityProgress } from './activity'
import Icon from './icons'
import { cx } from './ui'
import Popover from './Popover'

type Plan = Extract<Item, { kind: 'plan' }>
type Progress = ReturnType<typeof activityProgress>

export function PlanSteps({ plan, running = false }: { plan: Plan; running?: boolean }) {
  return <ol className="space-y-1 p-2" data-testid="plan-steps">{plan.steps.map((step, i) => <li key={i} data-testid="plan-step" aria-current={step.status === 'inProgress' ? 'step' : undefined} className={cx('flex items-start gap-2.5 rounded-lg px-2.5 py-2', step.status === 'inProgress' && 'bg-[var(--accent-soft)]')}>
    <span className={cx('mt-0.5 size-4 shrink-0 rounded-full grid place-items-center text-[11px] tabular-nums', step.status === 'completed' ? 'bg-accent text-white' : step.status === 'inProgress' ? 'border-[1.5px] border-accent text-accent' : 'border border-[var(--line)] text-[var(--muted)]')}>{step.status === 'completed' ? <Icon n="check" s={10} w={2.4} /> : i + 1}</span>
    <div className="min-w-0 flex-1"><p className={cx('text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', step.status === 'completed' ? 'text-[var(--muted)]' : step.status === 'inProgress' && 'font-medium')}>{step.content}</p>{step.status === 'inProgress' && <span className="text-[12px] text-accent">{running ? '当前步骤' : '待继续'}</span>}</div>
  </li>)}</ol>
}

export default function TaskProgress({ plan, progress, running, lifecycle, interrupted, error, onOpenChange, idleLabel, issueLabel, onInspectIssues, onPinPlan, planPinned, onResults }: {
  plan?: Plan; progress: Progress; running: boolean; lifecycle?: ThreadStatus['lifecycle']; interrupted?: boolean; error?: string
  onOpenChange: (open: boolean) => void; idleLabel: string; issueLabel: string; onInspectIssues: () => void
  onPinPlan: () => void; planPinned?: boolean; onResults: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const info = plan ? planProgress(plan) : undefined
  const waiting = lifecycle === 'waitingForPermission' || lifecycle === 'waitingForUser'
  const showLabel = running || interrupted || error || issueLabel
  const label = running ? progress.label : interrupted ? '已停止，可继续任务' : error ? '任务已暂停' : idleLabel
  useEffect(() => { if (!plan || planPinned) setOpen(false) }, [!!plan, planPinned])
  useEffect(() => { onOpenChange(open); return () => onOpenChange(false) }, [open, onOpenChange])
  return <div data-testid="task-progress-dock" className={cx('task-status-dock', !running && 'is-settled')}>
    <div className="flex items-start gap-2.5 min-w-0">
      {showLabel && <><span className={cx('mt-1 shrink-0', waiting || error || interrupted || issueLabel ? 'text-amber-600 dark:text-amber-300' : 'text-accent')}><Icon n={waiting ? 'shield' : interrupted ? 'stop' : error || issueLabel ? 'alert' : !running ? 'check' : 'list'} s={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-6 [overflow-wrap:anywhere]"><span role="status" aria-live="polite" data-testid="task-progress" className="font-medium">{label}</span>{running && progress.detail && <span data-testid="progress-subject" className="text-[var(--muted)]"> · {progress.detail}</span>}</div>
        {running && (progress.recent ? <p data-testid="progress-checkpoint" className="text-[12px] text-[var(--muted)] truncate" title={progress.recent}>{progress.recent}</p> : info?.current ? <p data-testid="current-plan-step" className="text-[12px] text-[var(--muted)] truncate" title={info.current.content}>当前计划 · {info.current.content}</p> : null)}
      </div>
      </>}
      {!showLabel && <span className="flex-1" />}
      {!running && <button onClick={onResults} className="status-action">本轮结果</button>}
      {plan && <button ref={trigger} data-testid="plan-toggle" aria-label={planPinned ? '查看固定的执行计划' : open ? '收起执行计划' : '展开执行计划'} aria-expanded={open || !!planPinned} onClick={() => planPinned ? onPinPlan() : setOpen(!open)} className="status-action"><span>计划</span><span className="tabular-nums text-[var(--muted)]">{info!.done}/{info!.total}</span><Icon n={planPinned ? 'pin' : 'down'} s={12} /></button>}
    </div>
    {(issueLabel || error) && <button data-testid="failure-overview" onClick={onInspectIssues} className="mt-1 flex items-start gap-2 text-left text-[12px] text-amber-700 dark:text-amber-300"><span className="line-clamp-2 [overflow-wrap:anywhere]">{issueLabel || error}</span><span className="shrink-0 text-accent">查看原因</span></button>}
    {open && plan && <Popover anchor={trigger} alignEnd above width={600} label="执行计划详情" testId="plan-popover" onClose={() => setOpen(false)}>
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-4 py-3"><span className="font-medium flex-1">执行计划</span><span className="text-[12px] text-[var(--muted)]">{info!.done}/{info!.total} 步</span><button className="status-action" onClick={() => { setOpen(false); onPinPlan() }}><Icon n="pin" s={13} />固定到侧栏</button></div>
      <div tabIndex={0} aria-label="计划步骤列表" className="min-h-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-accent"><PlanSteps plan={plan} running={running} /></div>
      {!!progress.milestones.length && <p data-testid="progress-milestones" className="border-t border-[var(--line)] p-3 text-[12px] text-[var(--muted)]">{progress.milestones.join(' · ')}</p>}
    </Popover>}
  </div>
}

export function PlanHistory({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false), info = planProgress(plan)
  return <section data-testid="plan-history" className="border-y border-[var(--line)]">
    <button aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 py-2.5 px-1 text-left text-[12px] hover:bg-[var(--hover)]"><Icon n="list" s={14} className="text-[var(--muted)]" /><span>本轮执行计划</span><span className="ml-auto tabular-nums text-[var(--muted)]">已完成 {info.done}/{info.total}</span><Icon n="chevron" s={12} className={cx('text-[var(--muted)]', open && 'rotate-90')} /></button>
    {open && <div className="max-h-72 overflow-auto"><PlanSteps plan={plan} /></div>}
  </section>
}
