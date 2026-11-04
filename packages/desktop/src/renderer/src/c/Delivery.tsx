import { useMemo, useState } from 'react'
import type { Session } from '../bridge'
import type { FileItem } from './Task'
import { assessmentLabels, type TurnAssessment } from '../../../../../kernel/src/protocol/assessment'
import { checkExplanation, deliveryModel } from './delivery-state'
import Icon from './icons'

const checkNames = { test: '测试', typecheck: '类型检查', lint: '代码检查', build: '构建', format: '格式检查' }
const states = { success: '通过', finding: '发现问题', unverified: '待验证', error: '未能完成', interrupted: '已停止' }
type Check = ReturnType<typeof deliveryModel>['checks'][number]

function CheckEvidence({ check, items }: { check: Check; items: Session['items'] }) {
  const [showOutput, setShowOutput] = useState(false)
  const { item, result } = check
  const { reason, skipReasons } = useMemo(() => checkExplanation(item, result), [item, result])
  const retry = result.recoveredBy ? items.find(entry => entry.id === result.recoveredBy) : undefined
  return <li data-testid="acceptance-check" className="rounded-lg border border-[var(--line)] p-3 text-[12px] [overflow-wrap:anywhere]">
    <div className="flex flex-wrap gap-x-2 gap-y-1 items-baseline">
      <span className="font-medium">{checkNames[result.check!]} · {states[result.kind]}</span>
      {!!result.skipped && <span className="text-amber-700 dark:text-amber-300">{result.skipped} 项跳过</span>}
      {result.recoveredBy && <span className="text-[var(--muted)]">已有后续复查</span>}
    </div>
    <p className="mt-1 font-mono text-[var(--muted)]">{item.command}</p>
    <p className="mt-1">{result.summary}</p>
    {reason && reason !== result.summary && <p className="mt-1 whitespace-pre-wrap">{reason}</p>}
    {(!!result.skipped || !!skipReasons.length) && <div className="mt-2 text-amber-700 dark:text-amber-300">
      <p className="font-medium">跳过原因</p>
      {skipReasons.length ? <ul className="pl-4 list-disc">{skipReasons.map(value => <li key={value}>{value}</li>)}</ul> : <p>已保存的输出中未找到具体跳过原因。</p>}
    </div>}
    <details className="mt-2" onToggle={event => { if (event.target === event.currentTarget) setShowOutput(event.currentTarget.open) }}>
      <summary className="cursor-pointer text-[var(--accent)]">查看原始证据</summary>
      {showOutput && <div className="mt-2 space-y-2">
        <p className="text-[var(--muted)]">退出码 {item.exitCode ?? '未记录'} · 已保存的命令输出</p>
        <pre tabIndex={0} aria-label="原始检查输出" className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--sunken)] p-3 font-mono [overflow-wrap:anywhere]">{item.output || '此条记录没有保存命令输出。'}</pre>
        {retry?.kind === 'commandExecution' && <details>
          <summary className="cursor-pointer text-[var(--accent)]">后续复查的原始证据</summary>
          <p className="mt-1 font-mono">{retry.command} · 退出码 {retry.exitCode ?? '未记录'}</p>
          <pre tabIndex={0} aria-label="复查输出" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--sunken)] p-3 font-mono [overflow-wrap:anywhere]">{retry.output || '此条记录没有保存命令输出。'}</pre>
        </details>}
      </div>}
    </details>
  </li>
}

function AcceptanceCard({ checks, items, assessment }: { checks: Check[]; items: Session['items']; assessment: TurnAssessment }) {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(20)
  return <details className="mt-4" data-testid="delivery-checks" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}>
    <summary className="cursor-pointer text-[12px] font-medium">验收卡 · {checks.length} 条检查记录{assessment.checks.passed ? ` · ${assessment.checks.passed} 项通过` : ''}{assessment.checks.skipped ? ` · ${assessment.checks.skipped} 项跳过` : ''}</summary>
    {open && <>
      <ul className="mt-2 space-y-2">{checks.slice(0, limit).map(check => <CheckEvidence key={check.id} check={check} items={items} />)}</ul>
      {limit < checks.length && <button type="button" className="mt-2 text-[12px] text-[var(--accent)] hover:underline" onClick={() => setLimit(previous => previous + 20)}>显示更多检查（还有 {checks.length - limit} 条）</button>}
    </>}
  </details>
}
export default function Delivery({ session, turnId, assessment, onOpenFile }: { session: Session; turnId: string; assessment: TurnAssessment; onOpenFile: (file: FileItem) => void }) {
  const result = useMemo(() => deliveryModel(session, turnId, assessment), [session.items, session.meta, session.summaries, session.error, session.interrupted, turnId, assessment])
  if (!result.show) return null
  const label = session.interrupted ? '已停止，已有结果已保留' : session.error ? '本轮结果 · 仍需处理' : assessmentLabels[assessment.status]
  return <section data-testid="delivery-summary" aria-label="本轮交付结果" className="delivery-summary">
    <header className="flex flex-wrap items-center gap-2"><Icon n={session.error || session.interrupted || assessment.status !== 'completed' ? 'alert' : 'check'} s={16} /><span data-testid="completion-status" className="font-medium">{label}</span>{result.durationMs !== undefined && <span className="ml-auto text-[12px] text-[var(--muted)] tabular-nums">用时 {(result.durationMs / 1000).toFixed(1)} 秒</span>}</header>
    {!!result.files.length && <div className="mt-4"><h3 className="text-[12px] font-medium text-[var(--muted)] mb-2">本轮文件 · {result.files.length}</h3><div className="delivery-files">{result.files.map(file => <button key={file.path} onClick={() => onOpenFile(file)} className="delivery-file" title={file.path}><Icon n="file" s={18} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{file.name}</span><span className="block text-[12px] text-[var(--muted)] truncate">{file.kind === 'del' ? '已删除 · 查看记录' : file.kind === 'new' ? '新建 · 打开预览' : '已修改 · 查看变更'}</span></span><Icon n="chevron" s={14} /></button>)}</div><p className="text-[12px] text-[var(--muted)] mt-2 truncate" title={session.meta.cwd}>执行位置：{session.meta.localSpace?'自动本地空间':session.meta.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</p></div>}
    {!!result.checks.length && <AcceptanceCard key={turnId} checks={result.checks} items={session.items} assessment={assessment} />}
    {assessment.verificationMissing && <p data-testid="delivery-unverified" className="mt-3 text-[12px] text-amber-700 dark:text-amber-300">本轮改动尚缺少验证记录，请检查结果后继续。</p>}
    {result.plan && !result.pending.length && <p className="mt-3 text-[12px] text-[var(--muted)]">执行计划：已完成 {result.plan.steps.length} / {result.plan.steps.length} 步。</p>}
    {!!result.pending.length && <details className="mt-3"><summary className="text-[12px] cursor-pointer text-amber-700 dark:text-amber-300">计划尚有 {result.pending.length} 项未完成</summary><ul className="mt-2 pl-4 list-disc text-[12px] text-[var(--muted)] space-y-1">{result.pending.map((step, index) => <li key={index}>{step.content}</li>)}</ul></details>}
  </section>
}
