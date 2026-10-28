import { needsSshSetup } from '../../../shared/ssh-routing'
import { useId, useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from 'react'
import Icon from './icons'
import Composer, { type ModelChoice } from './Composer'
import { Btn, cx, Menu } from './ui'
import { errorText, folderName, store, type Session, type Item, type ContextReference } from '../bridge'
import Md from './Markdown'
import { activityTimeline, activityProgress, latestPlan, type TimelineEntry } from './activity'
import TaskProgress, { PlanHistory } from './TaskProgress'
import { operationIssues, issueOverview, type OperationIssue } from './issues'
import { assessmentLabels, assessTurn, displayCommand, itemAssessment, operationAssessments, type ExecutionAssessment, type TurnAssessment } from '../../../../../kernel/src/protocol/assessment'
import { FailureSummary } from './Failures'
import ConversationSearch from './ConversationSearch'
import SteeringQueue from './SteeringQueue'
import Delivery from './Delivery'
import { ManagedTaskBadge } from './Autonomy'
import { CollaborationBadge } from './Collaborations'
import SshTargetBadge from './SshTargetBadge'
import ContainerTargetBadge from './ContainerTargetBadge'
import { workLocation } from './work-location'
import { RemoteOriginBadge } from './Remote'
export { artifacts } from './artifacts'
import { rememberExpansion, useConversationScroll, type ConversationScrollMemory } from './useConversationScroll'
export { default as Md } from './Markdown'
export type FileItem = { name: string; path: string; kind: 'new' | 'mod' | 'del'; add: number; del: number; diff?: string }
type Block =
  | { k: 'user'; text: string; references?: Array<{ path: string; label?: string }>; queued?: boolean }
  | { k: 'think'; text: string; done: boolean; secs: number }
  | { k: 'plan'; plan: Extract<Item, { kind: 'plan' }> }
  | { k: 'reads'; items: string[]; done: boolean }
  | { k: 'cmd'; cmd: string; out: string[]; code?: number; done: boolean; assessment?: ExecutionAssessment; external?: { status: string; origin?: string } }
  | { k: 'approval'; external?: { server: string; tool: string; origin: string }; id: string; risk: 'normal' | 'high'; title: string; detail: string; reason: string; rule: string; category?: string; batch?: number; operations?: Array<{ title: string; tool: string; input: unknown }>; res?: 'allow' | 'session' | 'always' | 'deny' }
  | { k: 'blocked'; title: string; reason: string }
  | { k: 'file'; f: FileItem; done: boolean }
  | { k: 'reply'; text: string; done: boolean }
  | { k: 'question'; q: string; opts: string[]; ans?: string }
  | { k: 'summary'; secs: number; tools: number; files: number; assessment?: TurnAssessment }
  | { k: 'error'; title: string; msg: string }


function block(item: Item, assessment = itemAssessment(item)): Block {
  switch (item.kind) {
    case 'userMessage': return { k: 'user', text: item.text, references: item.references }
    case 'agentMessage': return { k: 'reply', text: item.text, done: item.status !== 'inProgress' }
    case 'reasoning': return { k: 'think', text: item.text, done: item.status !== 'inProgress', secs: 0 }
    case 'plan': return { k: 'plan', plan: item }
    case 'fileChange':
      if (item.status === 'blocked') return { k: 'blocked', title: item.path, reason: item.diff || '文件操作被拒绝' }
      if (item.status !== 'completed') return { k: 'error', title: '文件操作失败 · ' + item.path, msg: item.diff || '请展开执行记录检查原因。' }
      return { k: 'file', done: true, f: { name: folderName(item.path), path: item.path, kind: item.changeKind === 'add' ? 'new' : item.changeKind === 'delete' ? 'del' : 'mod', add: item.diff?.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length ?? 0, del: item.diff?.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length ?? 0, diff: item.diff } }
    case 'commandExecution':
      if (item.status === 'blocked') return { k: 'blocked', title: item.command, reason: item.output }
      return { k: 'cmd', cmd: item.command, out: item.output.split('\n'), code: item.exitCode ?? undefined, done: item.status !== 'inProgress', assessment }
    case 'userInputRequest': return { k: 'question', q: item.question, opts: item.options ?? [], ans: item.answer }
    case 'mcpToolCall':
      if (item.status === 'blocked') return { k: 'blocked', title: item.server + '/' + item.tool, reason: item.output }
      return { k: 'cmd', cmd: item.server + '/' + item.tool, out: item.output.split('\n'), done: item.status !== 'inProgress', external: { status: item.status, origin: item.origin } }
  }
}
function operationTitle(tool: string, input: unknown, fallback: string) {
  const value = input as Record<string, unknown> | undefined
  if (tool === 'shell' && value) return '运行命令 · ' + displayCommand(value)
  const labels: Record<string, string> = { write: '写入文件', apply_patch: '修改文件', shell: '运行命令', read: '读取文件', grep: '搜索内容', glob: '查找文件', web_search: '联网搜索', web_fetch: '读取网页' }
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
export default function TaskView({ onSsh,onRemote, onCollaborations, onManage, session, scrollPositions, onOpenFile, model, setModel, models, mode, setMode, draft, setDraft, onSend, onError, onSettings, references, onReferencesChange, planPinned, onPinPlan, onInspectIssue, onOpenProcesses, onOpenBrowser }: { onSsh?:()=>void;onRemote?: () => void; onCollaborations?: () => void; onManage?: () => void; onOpenBrowser: (tabId?: string) => void; onOpenProcesses: () => void; onInspectIssue: (id: string) => void;
  session: Session; onOpenFile: (file: FileItem) => void; model: string; setModel: (model: string) => void; models: ModelChoice[]
  planPinned?: boolean; onPinPlan: () => void
  scrollPositions: ConversationScrollMemory
  mode: string; setMode: (mode: string) => void; draft: string; setDraft: (value: string) => void; onSend: (text: string) => Promise<void>
  references: ContextReference[]; onReferencesChange: (refs: ContextReference[]) => void
  onError: (error: string) => void; onSettings: () => void
}) {
  const scroll = useConversationScroll(session, scrollPositions)
  const browserOpener = useRef(onOpenBrowser); browserOpener.current = onOpenBrowser
  const openSource = useCallback(async (url: string) => {
    if (!store.api) throw new Error('桌面浏览接口暂时不可用，请稍后重试。')
    browserOpener.current()
    const opened = await store.api.browser<{ id: string }>('open', { threadId: session.meta.id, url })
    if (typeof opened.id !== 'string' || !opened.id) throw new Error('网页已创建，但未返回有效的标签，请在浏览侧栏检查。')
    browserOpener.current(opened.id)
  }, [session.meta.id])
  const running = store.busy(session.meta.id)
  const [managedLocked, setManagedLocked] = useState(false)
  const lifecycle = session.status?.lifecycle
  const lastTurnId = session.items.at(-1)?.turnId
  const timeline = useMemo(() => activityTimeline(session.items, lastTurnId), [session.items, lastTurnId])
  const [historyLimit, setHistoryLimit] = useState(() => scrollPositions.get(session.meta.id)?.historyLimit ?? 60)
  const [searchWindow, setSearchWindow] = useState<{ start: number; end: number } | undefined>(() => scrollPositions.get(session.meta.id)?.searchWindow)
  const prependAnchor = useRef<{ top: number; height: number }>(), previousLength = useRef(timeline.length)
  useLayoutEffect(() => {
    const added = timeline.length - previousLength.current
    if (previousLength.current > 0 && added > 0 && !scroll.stick) setHistoryLimit(count => count + added)
    previousLength.current = timeline.length
  }, [timeline.length, scroll.stick])
  useLayoutEffect(() => {
    const el = scroll.viewport.current, anchor = prependAnchor.current
    if (el && anchor) { el.scrollTop = anchor.top + el.scrollHeight - anchor.height; prependAnchor.current = undefined }
    const saved = scrollPositions.get(session.meta.id) ?? { top: 0, following: true }
    scrollPositions.set(session.meta.id, { ...saved, historyLimit, searchWindow })
  }, [historyLimit, searchWindow, scrollPositions, session.meta.id])
  const earlier = searchWindow?.start ?? Math.max(0, timeline.length - historyLimit)
  const visibleEnd = searchWindow?.end ?? timeline.length
  const loadEarlier = () => {
    const el = scroll.viewport.current
    if (el) prependAnchor.current = { top: el.scrollTop, height: el.scrollHeight }
    scroll.pauseBrowsing(); if (searchWindow) setSearchWindow({ ...searchWindow, start: Math.max(0, searchWindow.start - 60) }); else setHistoryLimit(count => count + 60)
  }
  const plan = useMemo(() => latestPlan(session.items, lastTurnId), [session.items, lastTurnId])
  const assessments = useMemo(() => operationAssessments(session.items), [session.items])
  const issues = useMemo(() => operationIssues(session.items.filter(item => item.turnId === lastTurnId), session.items, assessments), [session.items, lastTurnId, assessments])
  const latestAssessment = useMemo(() => {
    const items = session.items.filter(i => i.turnId === lastTurnId)
    const prompt = items.find(i => i.kind === 'userMessage')
    return assessTurn(items, prompt?.kind === 'userMessage' ? prompt.text : '', !!session.interrupted)
  }, [session.items, lastTurnId, session.interrupted])
  const failures = useRef<HTMLDivElement>(null), delivery = useRef<HTMLDivElement>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const onPlanOpenChange = useCallback((open: boolean) => setPlanOpen(open), [])
  const inspect = (issues: OperationIssue[], index: number) => { if (issues[index]) onInspectIssue(issues[index].id) }
  const [searchOpen, setSearchOpen] = useState(false), [located, setLocated] = useState<{ id: string; sequence: number }>()
  const searchButton = useRef<HTMLButtonElement>(null)
  const searchIssues = useMemo(() => operationIssues(session.items, session.items, assessments), [session.items, assessments])
  const locate = (id: string) => {
    const index = timeline.findIndex(entry => entry.kind === 'activity' ? entry.items.some(item => item.id === id) : entry.item.id === id)
    if (index < 0) return
    scroll.pauseBrowsing(); setSearchWindow({ start: Math.max(0, index - 15), end: Math.min(timeline.length, index + 45) })
    const entry = timeline[index]
    if (entry?.kind === 'activity') {
      rememberExpansion(scrollPositions, session.meta.id, 'activities', entry.id, true)
      rememberExpansion(scrollPositions, session.meta.id, 'commands', id, true)
      const saved = scrollPositions.get(session.meta.id) ?? { top: 0, following: false }
      scrollPositions.set(session.meta.id, { ...saved, detailWindows: { ...saved.detailWindows, [entry.id]: { start: Math.max(0, entry.items.findIndex(item => item.id === id) - 15), end: Math.min(entry.items.length, entry.items.findIndex(item => item.id === id) + 45) } } })
    }
    setLocated(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 }))
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && scroll.viewport.current?.clientHeight && !document.querySelector('[role="dialog"]')) { event.preventDefault(); setSearchOpen(true) }
    }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key)
  }, [])
  useEffect(() => {
    if (!located) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => scroll.viewport.current?.querySelector<HTMLElement>('[data-search-item="' + CSS.escape(located.id) + '"]')?.scrollIntoView({ block: 'center', behavior: 'instant' })) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [located, historyLimit, searchWindow])
  const progress = useMemo(() => activityProgress(session.items.filter(item => item.turnId === lastTurnId), { running, lifecycle, cwd: session.meta.cwd, interrupted: !!session.interrupted }, session.items, assessments), [session.items, lastTurnId, running, lifecycle, session.meta.cwd, session.interrupted, assessments])
  const respond = async (id: string, decision: string, reason?: string) => {
    try { await store.api!.respondApproval(id, decision === 'deny' ? { decision: 'deny', reason } : { decision: 'allow', scope: decision === 'category' ? 'category' : decision === 'batch' ? 'batch' : 'operation', remember: decision === 'session' || decision === 'always' ? decision : undefined }) }
    catch (err) { onError(errorText(err)); throw err }
  }
  const answer = async (id: string, text: string) => {
    try { await store.api!.respondInput(id, text) } catch (err) { onError(errorText(err)); throw err }
  }
  const stop = async () => { try { await store.api!.call('turn/interrupt', { threadId: session.meta.id }) } catch (err) { onError(errorText(err)) } }
  return <div data-testid="task-view" className="flex-1 flex flex-col min-w-0 min-h-0 relative">
    {onRemote && <RemoteOriginBadge session={session} onManage={onRemote} />}{onRemote&&<SshTargetBadge threadId={session.meta.id} onManage={onSsh??onRemote}/>}{onRemote&&<ContainerTargetBadge threadId={session.meta.id} onManage={onRemote}/>}
    {onSsh&&!session.meta.sshTarget&&!session.meta.containerTarget&&!session.meta.collaboration&&session.items.some(item=>item.turnId===lastTurnId&&item.kind==='commandExecution'&&(needsSshSetup(item.command+'\n'+item.output)||item.tool==='ssh_connections'&&item.output.includes('"setupRequired":true')))&&<div data-testid="ssh-setup-notice" className="mx-5 mt-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[12px] shrink-0"><p className="font-medium">SSH 尚未连接并绑定到此对话</p><p className="mt-1 text-[var(--muted)] leading-5">软件支持用户名和密码登录。在 SSH 项目中连接、核验主机身份，再绑定当前对话；无需配置免密登录，也不要在对话中填写密码或私钥。</p><Btn className="mt-2" v="outline" onClick={onSsh}>打开 SSH 连接</Btn></div>}

    {onCollaborations && <CollaborationBadge session={session} onManage={onCollaborations} />}
    {onManage && !session.meta.collaboration && <ManagedTaskBadge onLockChange={setManagedLocked} threadId={session.meta.id} onManage={onManage} onError={onError} />}
    <div className="conversation-tools gap-3"><button className="status-action" aria-label="打开浏览与网页预览" onClick={() => onOpenBrowser()}><Icon n="eye" s={13} />浏览预览</button><button className="status-action" aria-label="打开终端与后台进程" onClick={onOpenProcesses}><Icon n="terminal" s={13} />终端与进程</button><button ref={searchButton} className="status-action" aria-label="搜索对话 (Ctrl+F)" onClick={() => setSearchOpen(value => !value)}><Icon n="search" s={13} />搜索对话</button></div>
    {searchOpen && <ConversationSearch items={session.items} issues={searchIssues} onLocate={locate} onClose={() => { setSearchOpen(false); searchButton.current?.focus({ preventScroll: true }) }} />}
    <div ref={scroll.viewport} data-testid="conversation-scroll" role="region" aria-label="对话内容" tabIndex={0} onScroll={scroll.onScroll} onWheelCapture={scroll.onWheelCapture} onPointerDownCapture={scroll.onPointerDownCapture} onKeyDownCapture={scroll.onKeyDownCapture} className="flex-1 min-h-0 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--line)]">
      <div ref={scroll.content} className="max-w-[760px] mx-auto px-5 lg:px-8 pt-6 pb-10 space-y-3">
        {session.meta.recovery && !running && <div data-testid="recovery-banner" className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"><div className="font-medium text-[13px]">上次任务未完整结束</div><p className="mt-1 text-[12px] text-[var(--muted)] leading-relaxed">记录与已有文件已保留。请先检查实际结果，继续时会重新核对，避免重复执行。</p><Btn v="outline" disabled={!!session.meta.archived || !!session.meta.collaboration} className="mt-3" onClick={() => setDraft('继续上次任务，先检查已完成内容和实际文件状态，避免重复执行。')}>填写继续任务的说明</Btn></div>}
        {session.meta.archived && <div className="rounded-xl border border-[var(--line)] p-3 flex items-center gap-3 bg-[var(--sunken)]"><Icon n="archive" s={16} /><span className="flex-1 text-[12px] text-[var(--muted)]">这段对话已归档，恢复后可继续。</span><Btn v="outline" onClick={() => void store.restore(session.meta.id).catch(e => onError(errorText(e)))}>恢复对话</Btn></div>}
        {session.items.length === 0 && <div className="py-12 text-center text-[var(--muted)]">继续描述你希望完成的工作。</div>}
        {earlier > 0 && <button data-testid="load-earlier-history" onClick={loadEarlier} className="w-full py-2 text-[12px] text-accent rounded-lg hover:bg-[var(--hover)]">查看更早的记录（还有 {earlier} 条）</button>}
        {timeline.slice(earlier, visibleEnd).map(entry => entry.kind !== 'activity'
          ? <div key={entry.item.id} data-search-item={entry.item.id} className={located?.id === entry.item.id ? 'search-located' : undefined} data-testid={'item-' + entry.item.kind}><BlockView b={block(entry.item)} onResolve={() => {}} onAnswer={() => {}} onOpenFile={onOpenFile} onOpenLink={openSource} /></div>
          : <ActivityGroup located={located} key={entry.id} entry={entry} allItems={session.items} assessments={assessments} memory={scrollPositions} threadId={session.meta.id} onOpenFile={onOpenFile} onInspect={inspect} />)}
        {visibleEnd < timeline.length && <button data-testid="load-newer-history" onClick={() => setSearchWindow(before => before ? { ...before, end: Math.min(timeline.length, before.end + 60) } : before)} className="w-full py-2 text-[12px] text-accent rounded-lg hover:bg-[var(--hover)]">查看较新的记录（还有 {timeline.length - visibleEnd} 条）</button>}
        {Object.values(session.approvals).map(req => <div key={req.itemId} data-testid="approval"><BlockView b={{ k: 'approval', external: req.external, id: req.itemId, risk: req.riskLevel ?? 'normal', title: req.batch ? '同组 ' + (req.categoryLabel ?? '操作') + ' · ' + req.batch.length + ' 项' : operationTitle(req.tool, req.input, req.title), detail: JSON.stringify(req.batch ?? req.input, null, 2), reason: approvalReason(req.detail), rule: req.suggestedRule ?? req.tool, category: req.category === 'other' ? undefined : req.categoryLabel, batch: req.batch?.length, operations: req.batch?.map(op => ({ ...op, title: operationTitle(op.tool, op.input, op.title) })) }} onResolve={(decision, reason) => respond(req.itemId, decision, reason)} onAnswer={() => {}} onOpenFile={onOpenFile} /></div>)}
        {Object.values(session.questions).map(req => <div key={req.itemId} data-testid="question"><BlockView b={{ k: 'question', q: req.question, opts: req.options ?? [] }} onResolve={() => {}} onAnswer={text => answer(req.itemId, text)} onOpenFile={onOpenFile} /></div>)}
        {(session.error || issues.length > 0) && <div ref={failures}><FailureSummary key={lastTurnId} issues={issues} error={session.error} onInspect={inspect} onContinue={() => setDraft('请继续完成上次任务，先检查失败原因和已有结果，避免重复操作。')} onSettings={onSettings} /></div>}
        {!session.error && session.contextNotice?.level === 'warning' && <div data-testid="context-notice" role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[12px] leading-relaxed"><p className="font-medium">{session.contextNotice.message}</p>{session.contextNotice.reason && <p className="mt-1 break-words text-[var(--muted)]">具体原因：{session.contextNotice.reason}</p>}<p className="mt-1 text-[var(--muted)]">原始记录与已有文件保持完整。</p></div>}
        {!running && lastTurnId && <div ref={delivery}><Delivery session={session} turnId={lastTurnId} assessment={latestAssessment} onOpenFile={onOpenFile} /></div>}
      </div>
    </div>
    <div className="relative max-w-[760px] w-full mx-auto px-5 lg:px-8 pb-4">
      {(!scroll.stick || searchWindow) && !planOpen && <button data-testid="scroll-to-latest" onClick={() => { setSearchWindow(undefined); setLocated(undefined); scroll.latest() }} className="absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-40 h-8 px-3 flex items-center gap-1.5 whitespace-nowrap rounded-full glass border border-[var(--line)] shadow-lg text-[12px]"><Icon n="arrowDown" s={13} />{Object.keys(session.approvals).length ? '需要确认 · 查看最新' : Object.keys(session.questions).length ? '需要回答 · 查看最新' : scroll.hasUpdates ? '有新内容 · 查看最新' : '回到底部'}</button>}
      {(running || plan || session.interrupted || session.error || issues.length > 0) && <TaskProgress planPinned={planPinned} onPinPlan={onPinPlan} onResults={() => delivery.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })} key={lastTurnId} plan={plan} progress={progress} running={running} lifecycle={lifecycle} interrupted={session.interrupted} error={session.error} idleLabel={assessmentLabels[latestAssessment.status]} issueLabel={issueOverview(issues)} onInspectIssues={() => failures.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} onOpenChange={onPlanOpenChange} />}
      <SteeringQueue threadId={session.meta.id} entries={session.steering ?? []} onError={onError} />
      <Composer fileScope={session.meta.id} blockedHint={session.meta.collaboration ? "子任务由协作计划管理，请返回协作任务查看结果。" : undefined} submitBlocked={managedLocked || !!session.meta.collaboration} onPreview={ref => onOpenFile({ name: ref.label ?? folderName(ref.path), path: ref.path, kind: 'mod', add: 0, del: 0 })} references={references} onReferencesChange={onReferencesChange} approvedCategories={session.meta.approvedCategories} onResetPermissions={() => void store.updateThread(session.meta.id, {}, 'thread/permissions/reset').catch(e => onError(errorText(e)))} running={running} disabled={!!session.meta.archived || !!session.meta.collaboration} onSend={onSend} onStop={() => void stop()} value={draft} setValue={setDraft} mode={mode} setMode={setMode} model={model} setModel={setModel} models={models} ws={session.meta.cwd} workspaceLabel={workLocation(session.meta).label} workspaceTitle={workLocation(session.meta).detail} queued={session.steering?.length ? 0 : session.status?.queuedMessages} onError={onError} />
      <div className="text-center text-[11px] text-[var(--muted)]/80 mt-2">内容由 AI 生成，请核实重要信息</div>
    </div>
  </div>
}

function ActivityGroup({ entry, allItems, assessments, memory, threadId, onOpenFile, onInspect, located }: { located?: { id: string; sequence: number };
  allItems: Item[]
  assessments: Map<string, ExecutionAssessment>
  entry: Extract<TimelineEntry, { kind: 'activity' }>
  memory: ConversationScrollMemory; threadId: string
  onOpenFile: (file: FileItem) => void
  onInspect: (issues: OperationIssue[], index: number) => void
}) {
  const [expanded, setExpanded] = useState(() => memory.get(threadId)?.activities?.has(entry.id) ?? false)
  const [detailLimit, setDetailLimit] = useState(() => memory.get(threadId)?.detailLimits?.[entry.id] ?? 80)
  const [detailWindow, setDetailWindow] = useState<{ start: number; end: number } | undefined>(() => memory.get(threadId)?.detailWindows?.[entry.id])
  const detailRef = useRef<HTMLDivElement>(null), anchor = useRef<{ top: number; height: number }>()
  useLayoutEffect(() => {
    const el = detailRef.current
    if (el && anchor.current) { el.scrollTop = anchor.current.top + el.scrollHeight - anchor.current.height; anchor.current = undefined }
  }, [detailLimit, detailWindow])
  const showEarlier = () => {
    const el = detailRef.current; if (el) anchor.current = { top: el.scrollTop, height: el.scrollHeight }
    if (detailWindow) { updateDetailWindow({ ...detailWindow, start: Math.max(0, detailWindow.start - 80) }); return }
    const count = detailLimit + 80, saved = memory.get(threadId) ?? { top: 0, following: false }
    memory.set(threadId, { ...saved, detailLimits: { ...saved.detailLimits, [entry.id]: count } }); setDetailLimit(count)
  }
  const updateDetailWindow = (window: { start: number; end: number }) => {
    const saved = memory.get(threadId) ?? { top: 0, following: false }; memory.set(threadId, { ...saved, detailWindows: { ...saved.detailWindows, [entry.id]: window } }); setDetailWindow(window)
  }
  useLayoutEffect(() => {
    if (!located) return
    const index = entry.items.findIndex(item => item.id === located.id)
    if (index >= 0) { setExpanded(true); updateDetailWindow({ start: Math.max(0, index - 15), end: Math.min(entry.items.length, index + 45) }) }
  }, [located?.sequence])
  const detailId = useId()
  const issues = operationIssues(entry.items, allItems, assessments)
  return <section data-testid="activity-group" className="rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] overflow-hidden">
    <button type="button" data-testid="activity-toggle" aria-expanded={expanded} aria-controls={detailId} onClick={() => { rememberExpansion(memory, threadId, 'activities', entry.id, !expanded); setExpanded(!expanded) }} className="w-full px-3.5 py-3 flex items-start gap-2.5 text-left hover:bg-[var(--hover)] transition-colors">
      <span className="mt-0.5 text-[var(--muted)]"><Icon n="brain" s={15} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span className="font-medium">思考与执行记录</span>
          <span className="text-[11.5px] text-[var(--muted)]">{entry.items.length} 项记录</span>
        </div>
      </div>
      <span className="shrink-0 mt-0.5 flex items-center gap-1 text-[11px] text-[var(--muted)]"><span className="hidden sm:inline">{expanded ? '收起' : '详情'}</span><Icon n="chevron" s={13} className={cx('transition-transform', expanded && 'rotate-90')} /></span>
    </button>
    {issues.length > 0 && <button type="button" data-testid="activity-issue-preview" onClick={() => onInspect(issues, 0)} className={cx('w-full border-t border-[var(--line)] px-3.5 py-2.5 text-left flex items-start gap-2', issues[0]!.kind === 'error' ? 'bg-rose-500/[.035] text-rose-700 dark:text-rose-300' : 'bg-amber-500/[.035] text-amber-700 dark:text-amber-300')}><Icon n="alert" s={13} className="shrink-0 mt-0.5" /><span className="flex-1 min-w-0 text-[12px] line-clamp-2 break-words">{issues[0]!.reason}</span><span className="text-[11px] shrink-0 text-[var(--accent)]">查看原因{issues.length > 1 ? ` (${issues.length})` : ''}</span></button>}
    {expanded && <div ref={detailRef} id={detailId} role="region" aria-label="思考与执行详情" data-testid="activity-details" className="border-t border-[var(--line)] p-3 space-y-2.5 max-h-[480px] overflow-y-auto">
      {(detailWindow ? detailWindow.start > 0 : entry.items.length > detailLimit) && <button data-testid="load-earlier-execution" onClick={showEarlier} className="w-full py-2 text-[12px] text-accent hover:bg-[var(--hover)] rounded-lg">查看更早的 {detailWindow?.start ?? entry.items.length - detailLimit} 项执行记录</button>}
      {entry.items.slice(detailWindow?.start ?? -detailLimit, detailWindow?.end).map(item => <div key={item.id} data-search-item={item.id} className={located?.id === item.id ? 'search-located' : undefined} data-testid={'item-' + item.kind}>{item.kind === 'reasoning'
        ? <div className="border-l-2 border-[var(--line)] pl-3 py-1"><div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)] mb-1"><Icon n="brain" s={12} />{item.status === 'inProgress' ? '正在思考' : '思考过程'}</div><div className="text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-[var(--muted)]">{item.text || '正在分析任务…'}</div></div>
        : <BlockView b={block(item, assessments.get(item.id))} commandOpen={located?.id === item.id || memory.get(threadId)?.commands?.has(item.id)} onCommandToggle={open => rememberExpansion(memory, threadId, 'commands', item.id, open)} onResolve={() => {}} onAnswer={() => {}} onOpenFile={onOpenFile} />}</div>)}
      {detailWindow && detailWindow.end < entry.items.length && <button data-testid="load-newer-execution" onClick={() => updateDetailWindow({ ...detailWindow, end: Math.min(entry.items.length, detailWindow.end + 80) })} className="w-full py-2 text-[12px] text-accent">查看较新的执行记录</button>}
    </div>}
  </section>
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

function BlockView({ b, commandOpen, onCommandToggle, onResolve, onOpenFile, onAnswer, onOpenLink }: { b: Block; commandOpen?: boolean; onCommandToggle?: (open: boolean) => void; onResolve: (r: string, reason?: string) => void | Promise<void>; onOpenFile: (f: FileItem) => void; onAnswer: (a: string) => void | Promise<void>; onOpenLink?: (url: string) => Promise<void> | void }) {
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
    case 'plan': return <PlanHistory plan={b.plan} />
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
      return <div className={cx('anim-fade text-[14px] leading-[1.75] pt-1', !b.done && 'caret')}>{!b.done && b.text.length > 16000 ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{b.text}</div> : <Md text={b.text} onOpenLink={onOpenLink} />}</div>
    case 'question':
      return <QuestionCard b={b} onAnswer={onAnswer} />
    case 'summary':
      return (
        <div className="anim-rise flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-[12px] text-[var(--muted)]">
          <span data-testid="completion-status" className={cx('flex items-center gap-1.5 font-medium', !b.assessment || b.assessment.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300')}><Icon n={!b.assessment || b.assessment.status === 'completed' ? 'check' : 'alert'} s={14} />{b.assessment ? assessmentLabels[b.assessment.status] : '已完成'}</span>
          <span>用时 {b.secs}s</span><span>调用 {b.tools} 个工具</span><span>改动 {b.files} 个文件</span>
          {!!b.assessment?.recovered && <span>{b.assessment.recovered} 项已有后续结果</span>}
          {!!b.assessment?.pendingSteps && <span>计划剩余 {b.assessment.pendingSteps} 项</span>}
          {!!b.assessment?.checks.skipped && <span>{b.assessment.checks.skipped} 项检查跳过</span>}
          {b.assessment?.verificationMissing && <span>代码改动尚无验证记录</span>}
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
  useEffect(() => { if (open) setO(true) }, [open])
  const outputId = useId()
  return (
    <div className="anim-rise rounded-xl border border-[var(--line)] overflow-hidden bg-[var(--surface-solid)]">
      <button aria-expanded={o} aria-controls={outputId} onClick={() => { onToggle?.(!o); setO(!o) }} className="w-full flex items-center gap-2.5 px-3 h-9 hover:bg-[var(--hover)] transition">
        <Icon n={b.external ? "cpu" : "terminal"} s={15} className="text-[var(--muted)]" />
        <span className="font-mono text-[12.5px] truncate">{b.cmd}</span>
        <span className="flex-1" />
        {!b.done ? <span className="text-[11.5px] text-accent flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent animate-pulse" />运行中</span>
          : <span title={b.assessment?.recoveredBy ? `原退出码 ${b.code ?? '?'} · ${b.assessment.summary}` : b.assessment?.summary} className={cx('text-[11px] px-1.5 py-0.5 rounded shrink-0', b.assessment?.recoveredBy ? 'text-[var(--muted)] bg-[var(--sunken)]' : b.assessment?.kind === 'finding' || b.assessment?.kind === 'unverified' ? 'text-amber-700 dark:text-amber-300 bg-amber-500/10' : (b.external?.status === 'completed' || b.code === 0) ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-rose-500 bg-rose-500/10')}>{b.assessment?.recoveredBy ? b.assessment.recovery === 'alternative' ? '已改用其他工具' : '已有后续检查' : b.assessment?.kind === 'finding' ? '检查发现' : b.assessment?.kind === 'unverified' ? '待验证' : b.external ? b.external.status === 'completed' ? '已完成' : '调用失败' : b.code === undefined ? '已结束' : 'exit ' + b.code}</span>}
        <Icon n="chevron" s={13} className={cx('text-[var(--muted)] transition-transform', o && 'rotate-90')} />
      </button>
      {o && <div id={outputId} data-testid="command-output" className="bg-[#0d1017] text-[#c4cad6] font-mono text-[11.5px] leading-[1.7] px-3.5 py-2.5 max-h-44 overflow-auto">
          {b.out.map((l, i) => <div key={i} className="anim-fade whitespace-pre"><span className="text-[#4b5366] select-none mr-3">{String(i + 1).padStart(2, ' ')}</span>{l}</div>)}
          {!b.done && <span className="inline-block w-1.5 h-3.5 bg-[#c4cad6] animate-pulse align-middle" />}
      </div>}
    </div>
  )
}

function Approval({ b, onResolve }: { b: Extract<Block, { k: 'approval' }>; onResolve: (r: string, reason?: string) => void | Promise<void> }) {
  const [deny, setDeny] = useState(false), [busy, setBusy] = useState(false)
  const submitted = useRef(false), reasonInput = useRef<HTMLInputElement>(null)
  useEffect(() => { if (deny) reasonInput.current?.focus() }, [deny])
  const submit = async (decision: string, reason?: string) => { if (submitted.current) return; submitted.current = true; setBusy(true); try { await onResolve(decision, reason) } catch { submitted.current = false; setBusy(false) } }
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
    <fieldset disabled={busy} aria-busy={busy} className={cx('anim-rise relative rounded-2xl border-0 min-w-0 p-[1px] overflow-hidden', high ? 'bg-gradient-to-br from-rose-500 to-orange-400' : 'bg-gradient-to-br from-amber-400/80 via-amber-300/40 to-[var(--line)]')}>
      <div className="rounded-[15px] bg-[var(--surface-solid)] p-4">
        <div className="flex items-start gap-3">
          <div className={cx('size-9 rounded-xl grid place-items-center', high ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/12 text-amber-600')}><Icon n="shield" s={18} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2"><span className="font-semibold text-[14px]">需要你确认：{b.title}</span>{high && <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-rose-500 text-white">高风险</span>}</div>
            {b.external && <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[12px] break-all"><p className="font-medium">外部服务：{b.external.server}</p><p className="mt-1 text-[var(--muted)]">来源：{b.external.origin}</p><p className="mt-1 text-[var(--muted)]">参数将发送给此服务；服务自报只读不代表已获授权。</p></div>}{b.operations ? <div className="mt-3 space-y-1.5 max-h-60 overflow-y-auto">{b.operations.map((op, index) => <details key={index} className="rounded-lg border border-[var(--line)] bg-[var(--sunken)]"><summary className="cursor-pointer px-3 py-2 text-[12px] font-medium break-all">{op.title}</summary><pre className="px-3 pb-3 text-[11.5px] font-mono whitespace-pre-wrap break-all text-[var(--muted)] max-h-48 overflow-auto">{operationContent(op.input)}</pre></details>)}</div> : <div className="mt-2 font-mono text-[12.5px] px-3 py-2 rounded-lg bg-[var(--sunken)] border border-[var(--line)] break-all whitespace-pre-wrap max-h-52 overflow-y-auto"><span className="text-[var(--muted)] select-none">$ </span>{b.detail}</div>}
            <p className="mt-2 text-[12px] text-[var(--muted)] flex items-center gap-1.5"><Icon n="info" s={12} />{b.reason}</p>
          </div>
        </div>
        <div className={cx('fold-region', deny && 'open')}>
          <div><div className="pt-3 pl-12"><input ref={reasonInput} tabIndex={deny ? 0 : -1} disabled={!deny || busy} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="告诉 AI 为什么拒绝（可选）" className="w-full h-9 px-3 rounded-lg border border-[var(--line)] bg-[var(--sunken)] outline-none focus:border-accent/50" /></div></div>
        </div>
        <div className="flex items-center gap-2 mt-4 pl-12 flex-wrap">
          {deny ? (<><Btn v="danger" onClick={() => submit('deny', reason)}>确认拒绝</Btn><Btn v="ghost" onClick={() => setDeny(false)}>返回</Btn></>) : (<>
            <Btn v="primary" onClick={() => submit('allow')}><Icon n="check" s={14} w={2.2} />允许</Btn>
            {!high && b.batch && <Btn v="soft" onClick={() => submit('batch')}>允许本组 {b.batch} 项</Btn>}
            {!high && b.category && <Btn v="outline" onClick={() => submit('category')}>本对话允许同类{b.category}</Btn>}
            <Menu align="right" trigger={() => <Btn v="ghost"><Icon n="dots" s={14} />更多许可</Btn>} items={[
              { label: '本对话允许此规则', desc: b.rule, onClick: () => submit('session') },
              { label: '始终允许此规则', desc: '保存到设置：' + b.rule, onClick: () => submit('always') },
            ]} />
            <span className="flex-1" />
            <Btn v="ghost" className="text-rose-500" onClick={() => setDeny(true)}>拒绝</Btn>
          </>)}
        </div>
        <div className="mt-3 pl-12 text-[11px] text-[var(--muted)]">同类许可仅影响当前对话；高风险操作仍会询问。运行中可在输入框调整权限。<br />"始终允许"保存规则 <code className="font-mono">{b.rule}</code> · 5 分钟未处理将自动拒绝</div>
      </div>
    </fieldset>
  )
}

function QuestionCard({ b, onAnswer }: { b: Extract<Block, { k: 'question' }>; onAnswer: (a: string) => void | Promise<void> }) {
  const [sel, setSel] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const submitted = useRef(false)
  const submit = async (answer: string) => { if (submitted.current) return; submitted.current = true; setBusy(true); try { await onAnswer(answer) } catch { submitted.current = false; setBusy(false) } }
  const [other, setOther] = useState('')
  if (b.ans) return <div className="anim-fade flex items-center gap-2 text-[12.5px] text-[var(--muted)]"><Icon n="question" s={14} />{b.q}<span className="text-[var(--text)] font-medium">→ {b.ans}</span></div>
  return (
    <fieldset disabled={busy} aria-busy={busy} className="anim-rise min-w-0 rounded-2xl border border-accent/30 bg-[var(--surface-solid)] p-4 shadow-[0_8px_30px_-16px_rgba(47,79,208,.5)]">
      <div className="flex items-center gap-2 font-semibold text-[14px]"><Icon n="question" s={17} className="text-accent" />{b.q}</div>
      <div className="mt-3 grid gap-1.5">
        {b.opts.map((o) => (
          <button key={o} onClick={() => setSel(o)} className={cx('flex items-center gap-2.5 px-3 h-10 rounded-xl border text-left transition-all', sel === o ? 'border-accent bg-[var(--accent-soft)]' : 'border-[var(--line)] hover:bg-[var(--hover)]')}>
            <span className={cx('size-4 rounded-full border-[1.5px] grid place-items-center transition', sel === o ? 'border-accent' : 'border-[var(--line)]')}>{sel === o && <span className="size-2 rounded-full bg-accent anim-pop" />}</span>{o}
          </button>
        ))}
        <input value={other} onChange={(e) => { setOther(e.target.value); setSel(null) }} placeholder="其他，请输入…" className="h-10 px-3 rounded-xl border border-[var(--line)] bg-transparent outline-none focus:border-accent/50" />
      </div>
      <div className="flex justify-end mt-3"><Btn v="primary" disabled={!sel && !other} onClick={() => submit(sel || other)}>提交回答</Btn></div>
    </fieldset>
  )
}

export function FileIcon({ name, s = 32 }: { name: string; s?: number }) {
  const ext = name.split('.').pop()!
  const c: Record<string, string> = { xlsx: 'from-emerald-500 to-emerald-700', md: 'from-slate-500 to-slate-700', docx: 'from-sky-500 to-blue-700', pdf: 'from-rose-500 to-rose-700' }
  return <div style={{ width: s, height: s }} className={cx('rounded-lg bg-gradient-to-br grid place-items-center text-white text-[9px] font-bold uppercase shadow-sm', c[ext] || 'from-indigo-500 to-indigo-700')}>{ext.slice(0, 4)}</div>
}
