import { useId, useState, type ReactNode } from 'react'
import Icon from './icons'
import Composer, { type ModelChoice } from './Composer'
import { Btn, cx, Menu } from './ui'
import { errorText, folderName, store, type Session, type Item, type ContextReference } from '../bridge'
import Md from './Markdown'
import { activityTimeline, activityProgress, type TimelineEntry } from './activity'
import { rememberExpansion, useConversationScroll, type ConversationScrollMemory } from './useConversationScroll'
export { default as Md } from './Markdown'
export type FileItem = { name: string; path: string; kind: 'new' | 'mod' | 'del'; add: number; del: number; diff?: string }
type Step = { t: string; s: 'todo' | 'doing' | 'done' }
type Block =
  | { k: 'user'; text: string; references?: Array<{ path: string; label?: string }>; queued?: boolean }
  | { k: 'think'; text: string; done: boolean; secs: number }
  | { k: 'plan'; steps: Step[] }
  | { k: 'reads'; items: string[]; done: boolean }
  | { k: 'cmd'; cmd: string; out: string[]; code?: number; done: boolean }
  | { k: 'approval'; id: string; risk: 'normal' | 'high'; title: string; detail: string; reason: string; rule: string; category?: string; batch?: number; operations?: Array<{ title: string; tool: string; input: unknown }>; res?: 'allow' | 'session' | 'always' | 'deny' }
  | { k: 'blocked'; title: string; reason: string }
  | { k: 'file'; f: FileItem; done: boolean }
  | { k: 'reply'; text: string; done: boolean }
  | { k: 'question'; q: string; opts: string[]; ans?: string }
  | { k: 'summary'; secs: number; tools: number; files: number }
  | { k: 'error'; title: string; msg: string }

export type Phase = { s: string; label: string; detail?: string } | null


export function artifacts(session: Session): FileItem[] {
  const files = new Map<string, FileItem>()
  session.items.forEach(item => {
    if (item.kind !== 'fileChange' || item.status !== 'completed' || !item.path) return
    const root = session.meta.cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/'
    const path = item.path.replace(/\\/g, '/')
    const relative = path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path
    if (session.meta.restoredChanges?.[item.id in (session.meta.restoredChanges ?? {}) ? item.id : item.id.replace(/:\d+$/, '')]?.includes(relative)) return
    const previous = files.get(item.path)
    files.set(item.path, { name: folderName(item.path), path: item.path, kind: previous?.kind === 'new' && item.changeKind !== 'delete' ? 'new' : item.changeKind === 'add' ? 'new' : item.changeKind === 'delete' ? 'del' : 'mod',
      add: (item.diff?.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length ?? 0),
      del: (item.diff?.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length ?? 0), diff: item.diff })
  })
  return [...files.values()]
}
function block(item: Item): Block {
  switch (item.kind) {
    case 'userMessage': return { k: 'user', text: item.text, references: item.references }
    case 'agentMessage': return { k: 'reply', text: item.text, done: item.status !== 'inProgress' }
    case 'reasoning': return { k: 'think', text: item.text, done: item.status !== 'inProgress', secs: 0 }
    case 'plan': return { k: 'plan', steps: item.steps.map(s => ({ t: s.content, s: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'doing' : 'todo' })) }
    case 'fileChange':
      if (item.status !== 'completed') return { k: 'blocked', title: item.path, reason: item.diff || '文件操作失败或被拒绝' }
      return { k: 'file', done: true, f: { name: folderName(item.path), path: item.path, kind: item.changeKind === 'add' ? 'new' : item.changeKind === 'delete' ? 'del' : 'mod', add: item.diff?.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length ?? 0, del: item.diff?.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length ?? 0, diff: item.diff } }
    case 'commandExecution':
      if (item.status === 'blocked') return { k: 'blocked', title: item.command, reason: item.output }
      return { k: 'cmd', cmd: item.command, out: item.output.split('\n'), code: item.exitCode ?? undefined, done: item.status !== 'inProgress' }
    case 'userInputRequest': return { k: 'question', q: item.question, opts: item.options ?? [] }
    case 'mcpToolCall': return { k: 'cmd', cmd: item.server + '/' + item.tool, out: item.output.split('\n'), code: item.status === 'failed' ? 1 : 0, done: item.status !== 'inProgress' }
  }
}
function operationTitle(tool: string, input: unknown, fallback: string) {
  const value = input as Record<string, unknown> | undefined
  const labels: Record<string, string> = { write: '写入文件', apply_patch: '修改文件', shell: '运行命令', read: '读取文件', grep: '搜索内容', glob: '查找文件' }
  return (labels[tool] ?? fallback) + (typeof value?.path === 'string' ? ' · ' + value.path : '')
}
function approvalReason(reason?: string) {
  if (!reason || reason.startsWith('No rule allows')) return '当前权限设置需要你确认此类操作。'
  if (reason.startsWith('acceptEdits')) return '文件编辑已自动允许，命令执行需要确认。'
  if (reason.includes('OUTSIDE the workspace')) return '此操作将访问工作文件夹外的路径。'
  if (reason.startsWith('Dangerous command')) return '检测到高风险命令，请核对后单次允许。'
  if (reason.startsWith('Matched ask rule')) return '此操作匹配了你设置的询问规则。'
  return reason
}
function operationContent(input: unknown) {
  const value = input as Record<string, unknown> | undefined
  return String(value?.command ?? value?.patch ?? value?.content ?? JSON.stringify(input, null, 2))
}
export default function TaskView({ session, scrollPositions, onOpenFile, model, setModel, models, mode, setMode, draft, setDraft, onSend, onError, onSettings, references, onReferencesChange }: {
  session: Session; onOpenFile: (file: FileItem) => void; model: string; setModel: (model: string) => void; models: ModelChoice[]
  scrollPositions: ConversationScrollMemory
  mode: string; setMode: (mode: string) => void; draft: string; setDraft: (value: string) => void; onSend: (text: string) => Promise<void>
  references: ContextReference[]; onReferencesChange: (refs: ContextReference[]) => void
  onError: (error: string) => void; onSettings: () => void
}) {
  const scroll = useConversationScroll(session, scrollPositions)
  const running = store.busy(session.meta.id)
  const lifecycle = session.status?.lifecycle
  const timeline = activityTimeline(session.items)
  const lastTurnId = session.items.at(-1)?.turnId
  const progress = activityProgress(session.items.filter(item => item.turnId === lastTurnId), { running, lifecycle })
  const phase: Phase = running ? { s: lifecycle === 'waitingForPermission' ? 'approval' : lifecycle === 'waitingForUser' ? 'question' : lifecycle ?? 'prep', label: progress.label } : session.interrupted ? { s: 'stopped', label: '已停止，可继续任务' } : null
  const respond = async (id: string, decision: string, reason?: string) => {
    try { await store.api!.respondApproval(id, decision === 'deny' ? { decision: 'deny', reason } : { decision: 'allow', scope: decision === 'category' ? 'category' : decision === 'batch' ? 'batch' : 'operation', remember: decision === 'session' || decision === 'always' ? decision : undefined }) }
    catch (err) { onError(errorText(err)) }
  }
  const answer = async (id: string, text: string) => {
    try { await store.api!.respondInput(id, text) } catch (err) { onError(errorText(err)) }
  }
  const stop = async () => { try { await store.api!.call('turn/interrupt', { threadId: session.meta.id }) } catch (err) { onError(errorText(err)) } }
  return <div data-testid="task-view" className="flex-1 flex flex-col min-w-0 min-h-0 relative">
    <div ref={scroll.viewport} data-testid="conversation-scroll" role="region" aria-label="对话内容" tabIndex={0} onScroll={scroll.onScroll} onWheelCapture={scroll.onWheelCapture} onPointerDownCapture={scroll.onPointerDownCapture} onKeyDownCapture={scroll.onKeyDownCapture} className="flex-1 min-h-0 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--line)]">
      <div ref={scroll.content} className="max-w-[760px] mx-auto px-5 lg:px-8 pt-6 pb-10 space-y-3">
        {session.meta.archived && <div className="rounded-xl border border-[var(--line)] p-3 flex items-center gap-3 bg-[var(--sunken)]"><Icon n="archive" s={16} /><span className="flex-1 text-[12px] text-[var(--muted)]">这段对话已归档，恢复后可继续。</span><Btn v="outline" onClick={() => void store.restore(session.meta.id).catch(e => onError(errorText(e)))}>恢复对话</Btn></div>}
        {session.items.length === 0 && <div className="py-12 text-center text-[var(--muted)]">继续描述你希望完成的工作。</div>}
        {timeline.map((entry, index) => entry.kind === 'message'
          ? <div key={entry.item.id} data-testid={'item-' + entry.item.kind}><BlockView b={block(entry.item)} onResolve={() => {}} onAnswer={() => {}} onOpenFile={onOpenFile} /></div>
          : <ActivityGroup key={entry.id} entry={entry} memory={scrollPositions} threadId={session.meta.id} live={running && index === timeline.length - 1} lifecycle={lifecycle} interrupted={!!session.interrupted && entry.turnId === lastTurnId} onOpenFile={onOpenFile} />)}
        {Object.values(session.approvals).map(req => <div key={req.itemId} data-testid="approval"><BlockView b={{ k: 'approval', id: req.itemId, risk: req.riskLevel ?? 'normal', title: req.batch ? '同组 ' + (req.categoryLabel ?? '操作') + ' · ' + req.batch.length + ' 项' : operationTitle(req.tool, req.input, req.title), detail: JSON.stringify(req.batch ?? req.input, null, 2), reason: approvalReason(req.detail), rule: req.suggestedRule ?? req.tool, category: req.category === 'other' ? undefined : req.categoryLabel, batch: req.batch?.length, operations: req.batch?.map(op => ({ ...op, title: operationTitle(op.tool, op.input, op.title) })) }} onResolve={(decision, reason) => void respond(req.itemId, decision, reason)} onAnswer={() => {}} onOpenFile={onOpenFile} /></div>)}
        {Object.values(session.questions).map(req => <div key={req.itemId} data-testid="question"><BlockView b={{ k: 'question', q: req.question, opts: req.options ?? [] }} onResolve={() => {}} onAnswer={text => void answer(req.itemId, text)} onOpenFile={onOpenFile} /></div>)}
        {session.error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/[.06] p-4"><div className="flex items-center gap-2 text-rose-600 font-medium"><Icon n="alert" s={16} />任务执行失败</div><p className="mt-2 break-words text-[var(--muted)]">{session.error}</p><div className="flex gap-2 mt-3"><Btn v="outline" onClick={() => setDraft('请继续完成上次任务，并先检查失败原因。')}>继续任务</Btn><Btn onClick={onSettings}>打开模型设置</Btn></div></div>}
        {(!session.error && !session.interrupted ? session.summaries.slice(-1) : []).map(summary => <BlockView key={summary.turnId} b={{ k: 'summary', secs: Math.round(summary.durationMs / 100) / 10, tools: summary.toolCount, files: summary.fileCount }} onResolve={() => {}} onAnswer={() => {}} onOpenFile={onOpenFile} />)}
      </div>
    </div>
    <div className="relative max-w-[760px] w-full mx-auto px-5 lg:px-8 pb-4">
      {!scroll.stick && <button data-testid="scroll-to-latest" onClick={scroll.latest} className="absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-10 h-8 px-3 flex items-center gap-1.5 whitespace-nowrap rounded-full glass border border-[var(--line)] shadow-lg text-[12px]"><Icon n="arrowDown" s={13} />{Object.keys(session.approvals).length ? '需要确认 · 查看最新' : Object.keys(session.questions).length ? '需要回答 · 查看最新' : scroll.hasUpdates ? '有新内容 · 查看最新' : '回到底部'}</button>}
      <PhaseBar phase={phase} />
      <Composer references={references} onReferencesChange={onReferencesChange} approvedCategories={session.meta.approvedCategories} onResetPermissions={() => void store.updateThread(session.meta.id, {}, 'thread/permissions/reset').catch(e => onError(errorText(e)))} running={running} disabled={!!session.meta.archived} onSend={onSend} onStop={() => void stop()} value={draft} setValue={setDraft} mode={mode} setMode={setMode} model={model} setModel={setModel} models={models} ws={session.meta.cwd} queued={session.status?.queuedMessages} onError={onError} />
      <div className="text-center text-[11px] text-[var(--muted)]/80 mt-2">内容由 AI 生成，请核实重要信息</div>
    </div>
  </div>
}
function PhaseBar({ phase }: { phase: Phase }) {
  const attn = phase && (phase.s === 'approval' || phase.s === 'question')
  return (
    <div className={cx('fold-region', phase && 'open')}>
      <div>
        {phase && (
          <div role="status" aria-live="polite" aria-atomic="true" data-testid="task-progress" className={cx('mb-2 h-8 inline-flex items-center gap-2 px-3 rounded-full text-[12.5px]', attn ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30' : 'text-[var(--muted)]')}>
            {attn ? <span className="size-2 rounded-full bg-amber-500 pulse-ring" /> : phase.s === 'stopped' ? <Icon n="stop" s={12} /> : <Orbit />}
            <span className={cx(!attn && phase.s !== 'stopped' && 'shimmer-text', 'font-medium')}>{phase.label}</span>
            {phase.detail && <span className="font-mono text-[11.5px] opacity-80">{phase.detail}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityGroup({ entry, memory, threadId, live, lifecycle, interrupted, onOpenFile }: {
  entry: Extract<TimelineEntry, { kind: 'activity' }>; live: boolean; lifecycle?: NonNullable<Session['status']>['lifecycle']
  memory: ConversationScrollMemory; threadId: string
  interrupted: boolean; onOpenFile: (file: FileItem) => void
}) {
  const [expanded, setExpanded] = useState(() => memory.get(threadId)?.activities?.has(entry.id) ?? false)
  const detailId = useId()
  const progress = activityProgress(entry.items, { running: live, lifecycle, interrupted })
  const attention = live && (lifecycle === 'waitingForPermission' || lifecycle === 'waitingForUser')
  return <section data-testid="activity-group" className="rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] overflow-hidden">
    <button type="button" data-testid="activity-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={() => { rememberExpansion(memory, threadId, 'activities', entry.id, !expanded); setExpanded(!expanded) }} className="w-full px-3.5 py-3 flex items-start gap-2.5 text-left hover:bg-[var(--hover)] transition-colors">
      <span className="mt-0.5 text-[var(--muted)]">{live && !attention ? <Orbit /> : <Icon n={attention ? 'shield' : interrupted ? 'stop' : progress.issueCount ? 'alert' : 'brain'} s={15} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span className="font-medium">思考与执行</span>
          {live || interrupted ? <span className={cx('text-[12px]', attention ? 'text-amber-600 dark:text-amber-300' : 'text-[var(--muted)]')} data-testid="activity-stage">{progress.label}</span> : <span className="text-[11.5px] text-[var(--muted)]">{progress.count} 项记录</span>}
        </div>
        {progress.milestones.length > 0 && <p data-testid="activity-milestones" className="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">{progress.milestones.join(' · ')}</p>}
        {progress.warnings && <p role="note" data-testid="activity-warning" className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">{progress.warnings}，展开查看原因</p>}
      </div>
      <span className="shrink-0 mt-0.5 flex items-center gap-1 text-[11px] text-[var(--muted)]"><span className="hidden sm:inline">{expanded ? '收起' : '详情'}</span><Icon n="chevron" s={13} className={cx('transition-transform', expanded && 'rotate-90')} /></span>
    </button>
    {expanded && <div id={detailId} role="region" aria-label="思考与执行详情" data-testid="activity-details" className="border-t border-[var(--line)] p-3 space-y-2.5 max-h-[480px] overflow-y-auto">
      {entry.items.map(item => <div key={item.id} data-testid={'item-' + item.kind}>{item.kind === 'reasoning'
        ? <div className="border-l-2 border-[var(--line)] pl-3 py-1"><div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)] mb-1"><Icon n="brain" s={12} />{item.status === 'inProgress' ? '正在思考' : '思考过程'}</div><div className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-[var(--muted)]">{item.text || '正在分析任务…'}</div></div>
        : <BlockView b={block(item)} commandOpen={memory.get(threadId)?.commands?.has(item.id)} onCommandToggle={open => rememberExpansion(memory, threadId, 'commands', item.id, open)} onResolve={() => {}} onAnswer={() => {}} onOpenFile={onOpenFile} />}</div>)}
    </div>}
  </section>
}

function Orbit() {
  return <span className="relative inline-block shrink-0 size-3.5"><span className="absolute inset-0 rounded-full border-[1.5px] border-accent/25" /><span className="absolute inset-0 rounded-full border-[1.5px] border-accent border-r-transparent border-b-transparent spin" /></span>
}

function Fold({ head, children, open: init = false, tone }: { head: ReactNode; children: ReactNode; open?: boolean; tone?: string }) {
  const [o, setO] = useState(init)
  return (
    <div className={cx('anim-rise rounded-xl', tone)}>
      <button onClick={() => setO(!o)} className="group w-full flex items-center gap-2 py-1.5 text-left text-[var(--muted)] hover:text-[var(--text)] transition">
        {head}<Icon n="chevron" s={13} className={cx('transition-transform duration-200 opacity-0 group-hover:opacity-100', o && 'rotate-90 opacity-100')} />
      </button>
      <div className={cx('fold-region', o && 'open')}><div>{children}</div></div>
    </div>
  )
}

function BlockView({ b, commandOpen, onCommandToggle, onResolve, onOpenFile, onAnswer }: { b: Block; commandOpen?: boolean; onCommandToggle?: (open: boolean) => void; onResolve: (r: string, reason?: string) => void; onOpenFile: (f: FileItem) => void; onAnswer: (a: string) => void }) {
  switch (b.k) {
    case 'user':
      return (
        <div className="flex flex-col items-end anim-rise pt-2">
          <div className="max-w-[85%] min-w-0 px-4 py-2.5 rounded-2xl rounded-br-md bg-[var(--accent-soft)] text-[14px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{b.text}{!!b.references?.length && <div className="mt-2 flex flex-wrap gap-1.5">{b.references.map((ref, i) => <span key={i} title={ref.path} className="inline-flex items-center gap-1 max-w-full rounded-md bg-[var(--surface-solid)]/70 px-2 py-1 text-[11px] text-[var(--muted)]"><Icon n="file" s={12} className="shrink-0" /><span className="truncate">{ref.label ?? ref.path}</span></span>)}</div>}</div>
          {b.queued && <span className="mt-1 text-[11px] text-[var(--muted)] flex items-center gap-1"><Icon n="clock" s={11} />将在当前步骤后处理</span>}
        </div>
      )
    case 'think':
      return (
        <Fold head={<><Icon n="brain" s={15} /><span className={cx(!b.done && 'shimmer-text')}>{b.done ? '思考过程' : '思考中…'}</span></>}>
          <div className="ml-[7px] pl-4 border-l-2 border-[var(--line)] text-[var(--muted)] leading-relaxed py-1">{b.text}</div>
        </Fold>
      )
    case 'plan': {
      const d = b.steps.filter((s) => s.s === 'done').length
      return (
        <div className="anim-rise rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] p-3.5">
          <div className="flex items-center gap-2 mb-2.5"><Icon n="list" s={15} className="text-accent" /><span className="font-medium">执行计划</span><span className="ml-auto text-[12px] text-[var(--muted)]">{d}/{b.steps.length}</span></div>
          <div className="h-1 rounded-full bg-[var(--sunken)] overflow-hidden mb-3"><div className="h-full bg-accent rounded-full transition-all duration-700 ease-out" style={{ width: `${b.steps.length ? (d / b.steps.length) * 100 : 0}%` }} /></div>
          <div className="space-y-1.5">
            {b.steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className={cx('size-4 rounded-full grid place-items-center transition-all duration-300', s.s === 'done' ? 'bg-accent text-white scale-100' : s.s === 'doing' ? 'border-[1.5px] border-accent' : 'border-[1.5px] border-[var(--line)]')}>
                  {s.s === 'done' && <Icon n="check" s={10} w={3} />}{s.s === 'doing' && <span className="size-1.5 rounded-full bg-accent animate-pulse" />}
                </span>
                <span className={cx('transition-colors', s.s === 'done' ? 'text-[var(--muted)] line-through decoration-[var(--line)]' : s.s === 'doing' ? 'font-medium' : 'text-[var(--muted)]')}>{s.t}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    case 'reads':
      return (
        <Fold head={<><Icon n="eye" s={15} /><span className={cx(!b.done && 'shimmer-text')}>{b.done ? `查看了 ${b.items.length} 个文件` : `正在读取 ${b.items.length} 个文件…`}</span></>}>
          <div className="ml-[7px] pl-4 border-l-2 border-[var(--line)] py-1 space-y-1">{b.items.map((f) => <div key={f} className="flex items-center gap-2 text-[12.5px] text-[var(--muted)] font-mono anim-fade"><Icon n="file" s={12} />{f}</div>)}</div>
        </Fold>
      )
    case 'cmd':
      return <CmdBlock b={b} open={commandOpen} onToggle={onCommandToggle} />
    case 'approval':
      return <Approval b={b} onResolve={onResolve} />
    case 'blocked':
      return (
        <div className="anim-rise flex items-center gap-2.5 px-3 py-2 rounded-xl border border-dashed border-[var(--line)] text-[var(--muted)]">
          <Icon n="shield" s={15} /><span className="font-mono text-[12px] line-through">{b.title}</span><span className="text-[12px]">· 已阻止 · {b.reason}</span>
        </div>
      )
    case 'file':
      return (
        <button onClick={() => b.done && onOpenFile(b.f)} className="anim-rise w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] hover:border-accent/40 hover:shadow-[0_4px_16px_-8px_rgba(47,79,208,.4)] transition-all text-left group">
          <FileIcon name={b.f.name} />
          <div className="flex-1 min-w-0"><div className="font-medium truncate">{b.f.name}</div><div className="text-[11.5px] text-[var(--muted)] font-mono truncate">{b.f.path}</div></div>
          <span className={cx('text-[11px] px-1.5 py-0.5 rounded', b.f.kind === 'new' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-sky-500/10 text-sky-600 dark:text-sky-400')}>{b.f.kind === 'new' ? '新建' : '修改'}</span>
          {b.done ? <span className="font-mono text-[12px]"><span className="text-emerald-600 dark:text-emerald-400">+{b.f.add}</span> <span className="text-rose-500">−{b.f.del}</span></span> : <span className="size-3.5 rounded-full border-[1.5px] border-accent border-t-transparent spin" />}
          <Icon n="chevron" s={14} className="text-[var(--muted)] group-hover:translate-x-0.5 transition" />
        </button>
      )
    case 'reply':
      return <div className={cx('anim-fade text-[14px] leading-[1.75] pt-1', !b.done && 'caret')}><Md text={b.text} /></div>
    case 'question':
      return <QuestionCard b={b} onAnswer={onAnswer} />
    case 'summary':
      return (
        <div className="anim-rise flex items-center gap-4 pt-2 text-[12px] text-[var(--muted)]">
          <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium"><span className="size-4 rounded-full bg-emerald-500 text-white grid place-items-center"><Icon n="check" s={10} w={3} /></span>已完成</span>
          <span>用时 {b.secs}s</span><span>调用 {b.tools} 个工具</span><span>改动 {b.files} 个文件</span>
          <span className="flex-1" />


        </div>
      )
    case 'error':
      return (
        <div className="anim-rise rounded-xl border border-rose-500/30 bg-rose-500/[.06] p-4">
          <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-medium"><Icon n="alert" s={16} />{b.title}</div>
          <p className="mt-1 text-[var(--muted)] pl-6">{b.msg}</p>

        </div>
      )
  }
}

function CmdBlock({ b, open = false, onToggle }: { b: Extract<Block, { k: 'cmd' }>; open?: boolean; onToggle?: (open: boolean) => void }) {
  const [o, setO] = useState(open)
  const outputId = useId()
  return (
    <div className="anim-rise rounded-xl border border-[var(--line)] overflow-hidden bg-[var(--surface-solid)]">
      <button aria-expanded={o} aria-controls={outputId} onClick={() => { onToggle?.(!o); setO(!o) }} className="w-full flex items-center gap-2.5 px-3 h-9 hover:bg-[var(--hover)] transition">
        <Icon n="terminal" s={15} className="text-[var(--muted)]" />
        <span className="font-mono text-[12.5px] truncate">{b.cmd}</span>
        <span className="flex-1" />
        {!b.done ? <span className="text-[11.5px] text-accent flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent animate-pulse" />运行中</span>
          : <span className={cx('text-[11px] px-1.5 py-0.5 rounded', b.code === 0 ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-rose-500 bg-rose-500/10')}>{b.code === undefined ? '已结束' : 'exit ' + b.code}</span>}
        <Icon n="chevron" s={13} className={cx('text-[var(--muted)] transition-transform', o && 'rotate-90')} />
      </button>
      {o && <div id={outputId} data-testid="command-output" className="bg-[#0d1017] text-[#c4cad6] font-mono text-[11.5px] leading-[1.7] px-3.5 py-2.5 max-h-44 overflow-auto">
          {b.out.map((l, i) => <div key={i} className="anim-fade whitespace-pre"><span className="text-[#4b5366] select-none mr-3">{String(i + 1).padStart(2, ' ')}</span>{l}</div>)}
          {!b.done && <span className="inline-block w-1.5 h-3.5 bg-[#c4cad6] animate-pulse align-middle" />}
      </div>}
    </div>
  )
}

function Approval({ b, onResolve }: { b: Extract<Block, { k: 'approval' }>; onResolve: (r: string, reason?: string) => void }) {
  const [deny, setDeny] = useState(false)
  const [reason, setReason] = useState('')
  const high = b.risk === 'high'
  if (b.res) {
    const m = { allow: ['已允许', 'emerald'], session: ['本会话内已允许', 'emerald'], always: ['已始终允许 · 规则已写入', 'emerald'], deny: ['已拒绝', 'rose'] }[b.res]
    return (
      <div className="anim-fade flex items-center gap-2.5 px-3 h-9 rounded-xl bg-[var(--sunken)] text-[12.5px]">
        <Icon n="shield" s={14} className={m[1] === 'emerald' ? 'text-emerald-500' : 'text-rose-500'} />
        <span className="text-[var(--muted)]">{b.title}</span><span className="font-mono text-[12px] truncate">{b.detail}</span><span className="flex-1" />
        <span className={m[1] === 'emerald' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}>{m[0]}</span>
      </div>
    )
  }
  return (
    <div className={cx('anim-rise relative rounded-2xl p-[1px] overflow-hidden', high ? 'bg-gradient-to-br from-rose-500 to-orange-400' : 'bg-gradient-to-br from-amber-400/80 via-amber-300/40 to-[var(--line)]')}>
      <div className="rounded-[15px] bg-[var(--surface-solid)] p-4">
        <div className="flex items-start gap-3">
          <div className={cx('size-9 rounded-xl grid place-items-center', high ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/12 text-amber-600')}><Icon n="shield" s={18} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2"><span className="font-semibold text-[14px]">需要你确认：{b.title}</span>{high && <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-rose-500 text-white">高风险</span>}</div>
            {b.operations ? <div className="mt-3 space-y-1.5 max-h-60 overflow-y-auto">{b.operations.map((op, index) => <details key={index} className="rounded-lg border border-[var(--line)] bg-[var(--sunken)]"><summary className="cursor-pointer px-3 py-2 text-[12px] font-medium break-all">{op.title}</summary><pre className="px-3 pb-3 text-[11.5px] font-mono whitespace-pre-wrap break-all text-[var(--muted)] max-h-48 overflow-auto">{operationContent(op.input)}</pre></details>)}</div> : <div className="mt-2 font-mono text-[12.5px] px-3 py-2 rounded-lg bg-[var(--sunken)] border border-[var(--line)] break-all whitespace-pre-wrap max-h-52 overflow-y-auto"><span className="text-[var(--muted)] select-none">$ </span>{b.detail}</div>}
            <p className="mt-2 text-[12px] text-[var(--muted)] flex items-center gap-1.5"><Icon n="info" s={12} />{b.reason}</p>
          </div>
        </div>
        <div className={cx('fold-region', deny && 'open')}>
          <div><div className="pt-3 pl-12"><input autoFocus={deny} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="告诉 AI 为什么拒绝（可选）" className="w-full h-9 px-3 rounded-lg border border-[var(--line)] bg-[var(--sunken)] outline-none focus:border-accent/50" /></div></div>
        </div>
        <div className="flex items-center gap-2 mt-4 pl-12 flex-wrap">
          {deny ? (<><Btn v="danger" onClick={() => onResolve('deny', reason)}>确认拒绝</Btn><Btn v="ghost" onClick={() => setDeny(false)}>返回</Btn></>) : (<>
            <Btn v="primary" onClick={() => onResolve('allow')}><Icon n="check" s={14} w={2.2} />允许</Btn>
            {!high && b.batch && <Btn v="soft" onClick={() => onResolve('batch')}>允许本组 {b.batch} 项</Btn>}
            {!high && b.category && <Btn v="outline" onClick={() => onResolve('category')}>本对话允许同类{b.category}</Btn>}
            <Menu align="right" trigger={() => <Btn v="ghost"><Icon n="dots" s={14} />更多许可</Btn>} items={[
              { label: '本对话允许此规则', desc: b.rule, onClick: () => onResolve('session') },
              { label: '始终允许此规则', desc: '保存到设置：' + b.rule, onClick: () => onResolve('always') },
            ]} />
            <span className="flex-1" />
            <Btn v="ghost" className="text-rose-500" onClick={() => setDeny(true)}>拒绝</Btn>
          </>)}
        </div>
        <div className="mt-3 pl-12 text-[11px] text-[var(--muted)]">同类许可仅影响当前对话；高风险操作仍会询问。运行中可在输入框调整权限。<br />"始终允许"保存规则 <code className="font-mono">{b.rule}</code> · 5 分钟未处理将自动拒绝</div>
      </div>
    </div>
  )
}

function QuestionCard({ b, onAnswer }: { b: Extract<Block, { k: 'question' }>; onAnswer: (a: string) => void }) {
  const [sel, setSel] = useState<string | null>(null)
  const [other, setOther] = useState('')
  if (b.ans) return <div className="anim-fade flex items-center gap-2 text-[12.5px] text-[var(--muted)]"><Icon n="question" s={14} />{b.q}<span className="text-[var(--text)] font-medium">→ {b.ans}</span></div>
  return (
    <div className="anim-rise rounded-2xl border border-accent/30 bg-[var(--surface-solid)] p-4 shadow-[0_8px_30px_-16px_rgba(47,79,208,.5)]">
      <div className="flex items-center gap-2 font-semibold text-[14px]"><Icon n="question" s={17} className="text-accent" />{b.q}</div>
      <div className="mt-3 grid gap-1.5">
        {b.opts.map((o) => (
          <button key={o} onClick={() => setSel(o)} className={cx('flex items-center gap-2.5 px-3 h-10 rounded-xl border text-left transition-all', sel === o ? 'border-accent bg-[var(--accent-soft)]' : 'border-[var(--line)] hover:bg-[var(--hover)]')}>
            <span className={cx('size-4 rounded-full border-[1.5px] grid place-items-center transition', sel === o ? 'border-accent' : 'border-[var(--line)]')}>{sel === o && <span className="size-2 rounded-full bg-accent anim-pop" />}</span>{o}
          </button>
        ))}
        <input value={other} onChange={(e) => { setOther(e.target.value); setSel(null) }} placeholder="其他，请输入…" className="h-10 px-3 rounded-xl border border-[var(--line)] bg-transparent outline-none focus:border-accent/50" />
      </div>
      <div className="flex justify-end mt-3"><Btn v="primary" disabled={!sel && !other} onClick={() => onAnswer(sel || other)}>提交回答</Btn></div>
    </div>
  )
}

export function FileIcon({ name, s = 32 }: { name: string; s?: number }) {
  const ext = name.split('.').pop()!
  const c: Record<string, string> = { xlsx: 'from-emerald-500 to-emerald-700', md: 'from-slate-500 to-slate-700', docx: 'from-sky-500 to-blue-700', pdf: 'from-rose-500 to-rose-700' }
  return <div style={{ width: s, height: s }} className={cx('rounded-lg bg-gradient-to-br grid place-items-center text-white text-[9px] font-bold uppercase shadow-sm', c[ext] || 'from-indigo-500 to-indigo-700')}>{ext.slice(0, 4)}</div>
}
