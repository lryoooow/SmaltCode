import { useEffect, useMemo, useRef, useState } from 'react'
import { folderName, type Session } from '../bridge'
import { operationIssues, type OperationIssue } from './issues'
import type { FileItem } from './Task'
import { Btn, cx } from './ui'

export const issueLabel = (issue: OperationIssue) => issue.blocked ? '被阻止' : issue.kind === 'finding' ? '检查发现' : issue.kind === 'unverified' ? '待验证' : '执行失败'
export function issueFiles(issue: OperationIssue, session: Session): string[] {
  const item = session.items.find(item => item.id === issue.id)
  const paths = new Set<string>(item?.kind === 'fileChange' ? [item.path] : [])
  const pattern = /(?:[A-Za-z]:[\\/][^\r\n"<>|:]+?\.[A-Za-z0-9]+|(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:tsx?|jsx?|py|rs|go|java|json|md|css|html|ya?ml))(?=[:\s"')]|$)/g
  for (const match of issue.output.matchAll(pattern)) { if (paths.size >= 12) break; paths.add(match[0].trim()) }
  return [...paths]
}
export default function ErrorInspector({ session, requested, onOpenFile, onClose }: { onClose: () => void; session: Session; requested?: { id: string; sequence: number }; onOpenFile: (file: FileItem) => void }) {
  const all = useMemo(() => operationIssues(session.items), [session.items])
  const [scope, setScope] = useState('current'), [filter, setFilter] = useState('all'), [selected, setSelected] = useState(requested?.id)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected, scope, filter])
  const lastTurn = session.items.at(-1)?.turnId
  const [limit, setLimit] = useState(40)
  useEffect(() => { if (requested) { setScope('all'); setFilter('all'); setSelected(requested.id) } }, [requested?.sequence])
  const issues = useMemo(() => {
    const turns = new Map(session.items.map(item => [item.id, item.turnId]))
    return all.filter(issue => (scope === 'all' || turns.get(issue.id) === lastTurn) && (filter === 'all' || (filter === 'blocked' ? issue.blocked : !issue.blocked && issue.kind === filter)))
  }, [all, scope, filter, lastTurn, session.items])
  const issue = issues.find(issue => issue.id === selected) ?? (!selected ? issues[0] : undefined)
  const index = issue ? issues.indexOf(issue) : -1
  const visible = issues.slice(0, Math.max(limit, index + 1))
  return <section data-testid="error-inspector" aria-label="执行结果详情" className="flex flex-col flex-1 min-h-0 min-w-0" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}>
    <div className="p-3 border-b border-[var(--line)] flex flex-wrap gap-2 items-center"><h2 className="font-medium flex-1">错误检查器</h2><select aria-label="错误回合范围" value={scope} onChange={e => { setScope(e.target.value); setSelected(undefined); setLimit(40) }} className="bg-[var(--surface-solid)] text-[12px]"><option value="current">本轮</option><option value="all">全部历史</option></select><select aria-label="错误类型" value={filter} onChange={e => { setFilter(e.target.value); setSelected(undefined); setLimit(40) }} className="bg-[var(--surface-solid)] text-[12px]"><option value="all">全部类型</option><option value="error">执行失败</option><option value="finding">检查发现</option><option value="unverified">待验证</option><option value="blocked">被阻止</option></select></div>
    <div ref={list} role="listbox" aria-label="执行问题列表" className="max-h-48 overflow-auto border-b border-[var(--line)] p-2 shrink-0">{visible.map(value => <button key={value.id} role="option" aria-selected={issue?.id === value.id} onClick={() => setSelected(value.id)} className={cx('search-result', issue?.id === value.id && 'is-active')}><span className="text-[11px] text-[var(--muted)]">{issueLabel(value)}</span><span className="block text-[12px] break-words">{value.reason}</span></button>)}{visible.length < issues.length && <Btn onClick={() => setLimit(value => value + 40)}>继续查看 {issues.length - visible.length} 项</Btn>}{!issues.length && <p className="p-3 text-[12px] text-[var(--muted)]">此范围没有待处理问题。</p>}</div>
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">{issue ? <>
      <p className="text-[12px] text-[var(--muted)]">{index + 1} / {issues.length}</p><h3 className="text-[13px] font-medium break-words">{issue.title}</h3>
      <div className="border-l-2 border-amber-500 pl-3"><p className="text-[13px] whitespace-pre-wrap break-words">{issueLabel(issue)}：{issue.reason}</p><p className="mt-2 text-[12px] text-[var(--muted)]">{issue.hint}</p></div>
      {!!issueFiles(issue, session).length && <div className="space-y-1"><p className="text-[12px] text-[var(--muted)]">关联文件（来自记录，打开时检查工作区权限）</p>{issueFiles(issue, session).map(path => <button key={path} className="block text-left max-w-full break-all text-[12px] text-accent hover:underline" onClick={() => onOpenFile({ name: folderName(path), path, kind: 'mod', add: 0, del: 0 })}>{path}</button>)}</div>}
      <div className="flex items-center justify-between gap-2"><label className="text-[12px] text-[var(--muted)]">原始执行输出</label><div className="flex gap-1"><Btn disabled={index <= 0} onClick={() => setSelected(issues[index - 1]?.id)}>上一项</Btn><Btn disabled={index >= issues.length - 1} onClick={() => setSelected(issues[index + 1]?.id)}>下一项</Btn></div></div>
      <pre tabIndex={0} aria-label="原始执行输出" className="p-3 bg-[var(--sunken)] rounded-lg font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{issue.output || '没有保存更多执行输出。'}</pre>
    </> : selected ? <p role="status" className="text-[12px] text-[var(--muted)]">该问题已由后续结果处理，或不在当前筛选范围中。原始记录仍保留在对话内。</p> : null}</div>
  </section>
}
