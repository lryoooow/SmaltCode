import { useState } from 'react'
import { Modal } from './Overlays'
import { Btn } from './ui'
import Icon from './icons'
import type { OperationIssue } from './issues'
import { issueOverview } from './issues'
import { cx } from './ui'

const severity = (issue: OperationIssue) => issue.kind === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300'
const issueLabel = (issue: OperationIssue) => issue.blocked ? '被阻止' : issue.kind === 'finding' ? '检查发现' : issue.kind === 'unverified' ? '待验证' : '执行失败'

export function FailureSummary({ issues, error, onInspect, onContinue, onSettings }: {
  issues: OperationIssue[]; error?: string; onInspect: (issues: OperationIssue[], index: number) => void
  onContinue: () => void; onSettings: () => void
}) {
  const [all, setAll] = useState(false)
  const hasError = !!error || issues.some(i => i.kind === 'error')
  return <section data-testid="failure-summary" aria-label="本轮执行与检查结果" className={cx('rounded-xl border p-4 space-y-3', hasError ? 'border-rose-500/25 bg-rose-500/[.045]' : 'border-amber-500/25 bg-amber-500/[.045]')}>
    <div className={cx('flex items-center gap-2 font-medium text-[13px]', hasError ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}><Icon n="alert" s={16} />{error ? '任务已暂停' : '执行与检查结果'}{issues.length > 0 && <span className="ml-auto text-[11px] font-normal">{issueOverview(issues)}</span>}</div>
    {error && <p role="alert" data-testid="task-error" className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">{error}</p>}
    {issues.length > 0 && <ol className="space-y-2">
      {(all ? issues : issues.slice(0, 3)).map((issue, index) => <li key={issue.id} data-testid="failure-reason" className="rounded-lg bg-[var(--surface-solid)] border border-[var(--line)] p-3">
        <div className="flex gap-2 items-start"><span className={cx('text-[11px] shrink-0 mt-0.5', severity(issue))}>{issueLabel(issue)} {index + 1}</span><span className="text-[12px] font-medium truncate flex-1 min-w-0" title={issue.title}>{issue.title}</span><button className="text-[11.5px] text-[var(--accent)] shrink-0 hover:underline" aria-label={'查看失败记录 ' + (index + 1)} onClick={() => onInspect(issues, index)}>完整记录</button></div>
        <p className={cx('mt-1.5 text-[12px] leading-relaxed break-words', severity(issue))}>{issue.reason}</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">{issue.hint}</p>
      </li>)}
    </ol>}
    {issues.length > 3 && <button onClick={() => setAll(!all)} className="text-[12px] text-[var(--accent)] hover:underline">{all ? '收起更多原因' : `查看全部 ${issues.length} 项原因`}</button>}
    {error && <div className="flex flex-wrap gap-2"><Btn v="outline" onClick={onContinue}>填写继续任务说明</Btn><Btn v="ghost" onClick={onSettings}>模型设置</Btn></div>}
  </section>
}

export function FailureDetails({ issues, index, onChange, onClose }: { issues: OperationIssue[]; index: number; onChange: (index: number) => void; onClose: () => void }) {
  const issue = issues[index]!
  return <Modal label="执行结果详情" w="w-[820px]" onClose={onClose}>
    <div className="p-5 flex flex-col gap-3 min-w-0">
      <div className="flex justify-between items-center gap-3"><h2 className="font-semibold">执行结果详情 <span className="ml-2 text-[12px] text-[var(--muted)] font-normal">{index + 1} / {issues.length}</span></h2><Btn v="ghost" onClick={onClose}>关闭</Btn></div>
      <p className="text-[12px] font-medium break-words">{issue.title}</p>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--sunken)] p-3"><p className={cx('text-[12.5px] break-words', severity(issue))}>{issueLabel(issue)}：{issue.reason}</p><p className="mt-1 text-[12px] text-[var(--muted)]">{issue.hint}</p></div>
      <label className="text-[11.5px] text-[var(--muted)]">原始执行输出</label>
      <pre tabIndex={0} aria-label="原始执行输出" className="p-3 rounded-lg border border-[var(--line)] bg-[var(--sunken)] text-[11.5px] leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[45vh]">{issue.output || '没有保存更多执行输出。'}</pre>
      <div className="flex gap-2 justify-end"><Btn v="outline" disabled={index === 0} onClick={() => onChange(index - 1)}>上一项</Btn><Btn v="outline" disabled={index === issues.length - 1} onClick={() => onChange(index + 1)}>下一项</Btn></div>
    </div>
  </Modal>
}
