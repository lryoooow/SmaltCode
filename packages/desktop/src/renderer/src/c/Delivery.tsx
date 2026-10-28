import { useMemo } from 'react'
import type { Session } from '../bridge'
import type { FileItem } from './Task'
import { assessmentLabels, type TurnAssessment } from '../../../../../kernel/src/protocol/assessment'
import { deliveryModel } from './delivery-state'
import Icon from './icons'

const checkNames = { test: '测试', typecheck: '类型检查', lint: '代码检查', build: '构建', format: '格式检查' }
const states = { success: '通过', finding: '发现问题', unverified: '待验证', error: '未能完成', interrupted: '已停止' }
export default function Delivery({ session, turnId, assessment, onOpenFile }: { session: Session; turnId: string; assessment: TurnAssessment; onOpenFile: (file: FileItem) => void }) {
  const result = useMemo(() => deliveryModel(session, turnId, assessment), [session.items, session.meta, session.summaries, session.error, session.interrupted, turnId, assessment])
  if (!result.show) return null
  const label = session.interrupted ? '已停止，已有结果已保留' : session.error ? '本轮结果 · 仍需处理' : assessmentLabels[assessment.status]
  return <section data-testid="delivery-summary" aria-label="本轮交付结果" className="delivery-summary">
    <header className="flex flex-wrap items-center gap-2"><Icon n={session.error || session.interrupted || assessment.status !== 'completed' ? 'alert' : 'check'} s={16} /><span data-testid="completion-status" className="font-medium">{label}</span>{result.durationMs !== undefined && <span className="ml-auto text-[12px] text-[var(--muted)] tabular-nums">用时 {(result.durationMs / 1000).toFixed(1)} 秒</span>}</header>
    {!!result.files.length && <div className="mt-4"><h3 className="text-[12px] font-medium text-[var(--muted)] mb-2">本轮文件 · {result.files.length}</h3><div className="delivery-files">{result.files.map(file => <button key={file.path} onClick={() => onOpenFile(file)} className="delivery-file" title={file.path}><Icon n="file" s={18} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{file.name}</span><span className="block text-[12px] text-[var(--muted)] truncate">{file.kind === 'del' ? '已删除 · 查看记录' : file.kind === 'new' ? '新建 · 打开预览' : '已修改 · 查看变更'}</span></span><Icon n="chevron" s={14} /></button>)}</div><p className="text-[12px] text-[var(--muted)] mt-2 truncate" title={session.meta.cwd}>执行位置：{session.meta.localSpace?'自动本地空间':session.meta.cwd.split(/[\\/]/).filter(Boolean).at(-1)}</p></div>}
    {!!result.checks.length && <details className="mt-4" data-testid="delivery-checks"><summary className="text-[12px] font-medium cursor-pointer">检查证据 · {result.checks.length} 项{assessment.checks.passed ? ` · ${assessment.checks.passed} 项通过` : ''}{assessment.checks.skipped ? ` · ${assessment.checks.skipped} 项跳过` : ''}</summary><ul className="mt-2 space-y-2">{result.checks.map(check => <li key={check.id} className="text-[12px] break-words"><span className="font-medium">{checkNames[check.result.check!]} · {check.result.recoveredBy ? '已有后续复查' : states[check.result.kind]}</span><p className="font-mono text-[var(--muted)] mt-0.5">{check.command}</p><p className="text-[var(--muted)]">{check.result.summary}</p></li>)}</ul></details>}
    {assessment.verificationMissing && <p data-testid="delivery-unverified" className="mt-3 text-[12px] text-amber-700 dark:text-amber-300">本轮改动尚缺少验证记录，请检查结果后继续。</p>}
    {result.plan && !result.pending.length && <p className="mt-3 text-[12px] text-[var(--muted)]">执行计划：已完成 {result.plan.steps.length} / {result.plan.steps.length} 步。</p>}
    {!!result.pending.length && <details className="mt-3"><summary className="text-[12px] cursor-pointer text-amber-700 dark:text-amber-300">计划尚有 {result.pending.length} 项未完成</summary><ul className="mt-2 pl-4 list-disc text-[12px] text-[var(--muted)] space-y-1">{result.pending.map((step, index) => <li key={index}>{step.content}</li>)}</ul></details>}
  </section>
}
