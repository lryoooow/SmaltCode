import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Processes from './Processes'
import Browser from './Browser'
import McpResults from './McpResults'
import ErrorInspector from './ErrorInspector'
import { operationIssues } from './issues'
import Icon from './icons'
import { FileIcon, type FileItem } from './Task'
import { cx, IconBtn, Btn, Menu } from './ui'
import Popover from './Popover'
import { latestPlan } from './activity'
import { PlanSteps } from './TaskProgress'
import { errorText, store, type Session, type ContextReference } from '../bridge'
import Md from './Markdown'
import Review from './Review'
import DocumentView from './DocumentView'
import { applyBrowserPreviewRequest, applyPreviewRequest, closePreview, emptyPreview, openPreview, trimPreviewMemory, type BrowserPreviewRequest, type PreviewMemory, type PreviewState } from './preview-state'

export default function Panel({ files, sel, setSel, onClose, session, onError, memory, onReference, focus, onFocus, planPinned, planRequest, onUnpinPlan, errorRequest, processRequest, browserRequest, onOpenThread }: { browserRequest?: BrowserPreviewRequest; processRequest?: number; onOpenThread: (id: string) => void; errorRequest?: { id: string; sequence: number }; focus: boolean; onFocus: () => void; planPinned: boolean; planRequest: number; onUnpinPlan: () => void;  files: FileItem[]; sel: FileItem | null; setSel: (file: FileItem | null) => void; onClose: () => void; session: Session; onError: (message: string) => void; memory: PreviewMemory; onReference: (ref: ContextReference) => void }) {
  const id = session.meta.id
  useEffect(() => { if (processRequest) change(value => applyPreviewRequest(value, 'processes', processRequest)) }, [processRequest])
  useEffect(() => { if (browserRequest) change(value => applyBrowserPreviewRequest(value, browserRequest)) }, [browserRequest?.sequence, browserRequest?.target])
  const hasIssues = operationIssues(session.items).length > 0
  useEffect(() => { if (errorRequest) change(value => applyPreviewRequest(value, 'issues', errorRequest.sequence)) }, [errorRequest?.sequence])
  const [statistics, setStatistics] = useState(false), [tabMenu, setTabMenu] = useState<string>()
  const statisticsAnchor = useRef<HTMLDivElement>(null), tabAnchor = useRef<HTMLDivElement | null>(null)
  const fileTabs = useRef<HTMLDivElement>(null)
  const plan = latestPlan(session.items, session.items.at(-1)?.turnId)
  useEffect(() => { if (planPinned && planRequest) change(value => applyPreviewRequest(value, 'plan', planRequest)) }, [planRequest])
  const [view, setView] = useState(() => memory.get(id) ?? emptyPreview())
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>(), [source, setSource] = useState(false), [selection, setSelection] = useState<{ start: number; end: number }>()
  const mounted = useRef(true), viewport = useRef<HTMLDivElement>(null), request = useRef(0)
  const change = (fn: (value: PreviewState) => PreviewState) => setView(previous => { const next = fn({ ...previous, scroll: memory.get(id)?.scroll ?? previous.scroll }); memory.delete(id); memory.set(id, next); trimPreviewMemory(memory, id, next.active); return memory.get(id)! })
  const active = view.tabs.find(tab => tab.path === view.active)
  useEffect(() => { fileTabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [view.active])
  const preview = active ? view.previews[active.path] : undefined
  const showDiff = active ? view.diff[active.path] : false
  const version = (path: string) => { const file = files.find(f => f.path.replace(/\\/g, '/') === path.replace(/\\/g, '/')); return JSON.stringify([file ? [file.kind, file.diff, file.add, file.del] : null,store.artifactRevision(session.meta.cwd,path)]) }
  const stale = active && preview && view.versions[active.path] !== version(active.path)
  const position = active ? view.documentPositions?.[active.path] ?? {} : {}
  const scrollKey = (active?.path ?? '') + ':' + (showDiff ? 'diff' : 'content') + (preview?.format === 'pdf' ? ':' + (position.page ?? 1) : preview?.format === 'xlsx' ? ':' + (position.sheet ?? 0) : '')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (sel) { change(value => openPreview(value, sel)); setSel(null) } }, [sel])
  const load = async (file: FileItem) => {
    const token = ++request.current; setLoading(true); setError(undefined)
    try {
      const result = await store.api!.file(id, file.path, 'read')
      if (mounted.current && token === request.current) change(value => value.tabs.some(tab => tab.path === file.path) ? { ...value, previews: { ...value.previews, [file.path]: result }, versions: { ...value.versions, [file.path]: version(file.path) } } : value)
    } catch (e) { if (mounted.current && token === request.current) setError(errorText(e)) }
    finally { if (mounted.current && token === request.current) setLoading(false) }
  }
  useEffect(() => { setSource(false); setSelection(undefined); setError(undefined); if (active && active.kind !== 'del' && !preview) void load(active); else { request.current++; setLoading(false) } }, [active?.path])
  useLayoutEffect(() => { if (viewport.current) viewport.current.scrollTop = memory.get(id)?.scroll[scrollKey] ?? 0 }, [scrollKey, !!preview, source])
  const open = (file: FileItem) => change(value => openPreview(value, file))
  const tabs = [['out', '产物'], ['chg', '变更'], ['processes', '终端'], ['browser', '浏览'], ...(session.items.some(item => item.kind === 'mcpToolCall' && item.resultId) ? [['mcp', '工具结果']] : []), ...((hasIssues || errorRequest) ? [['issues', '问题']] : []), ...(planPinned ? [['plan', '计划']] : [])]
  const reference = () => {
    if (!active || !preview?.digest || !selection) return
    const startLine = preview.text.slice(0, selection.start).split('\n').length
    onReference({ path: active.path, start: selection.start, end: selection.end, digest: preview.digest, label: active.name + ':L' + startLine })
    setSelection(undefined)
  }
  const reveal = async () => { if (active) try { await store.api!.file(id, active.path, 'reveal') } catch (e) { onError(errorText(e)) } }
  const restored = () => { change(value => ({ ...value, previews: {} })); if (active && active.kind !== 'del') void load(active) }
  const closeTabs = (paths: string[]) => change(value => paths.reduce((next, path) => closePreview(next, path), value))
  return <aside data-testid="artifact-panel" className="detail-panel flex-1 flex flex-col min-h-0 min-w-0 bg-[var(--surface-solid)]" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && active) { event.preventDefault(); event.stopPropagation(); closeTabs([active.path]) }
  }}>
    <header className="inspector-toolbar">
      <div className="flex min-w-0 flex-1 overflow-x-auto items-center gap-0.5">
        {tabs.map(([key, label]) => <button key={key} onClick={() => change(value => ({ ...value, section: key, active: null }))} aria-pressed={view.section === key && !active} className={cx('panel-tab', view.section === key && !active && 'is-active')}>{label}</button>)}
        {!!view.tabs.length && <div ref={fileTabs} role="tablist" aria-label="文件预览标签" className="flex min-w-0 items-center gap-0.5" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target instanceof Element) || event.target.getAttribute('role') !== 'tab') return
          event.preventDefault(); const buttons = Array.from(fileTabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
          if (view.tabs[next]) { change(value => ({ ...value, active: view.tabs[next].path })); buttons[next]?.focus({ preventScroll: true }) }
        }}>{view.tabs.map(file => <div key={file.path} onPointerDown={e => { if (e.button === 1) { e.preventDefault(); closeTabs([file.path]) } }} onContextMenu={e => { e.preventDefault(); tabAnchor.current = e.currentTarget; setTabMenu(file.path) }} className={cx('panel-file-tab', file.path === view.active && 'is-active')}>
          <button role="tab" aria-selected={file.path === view.active} title={file.path} onClick={() => change(value => ({ ...value, active: file.path }))} className="flex min-w-0 items-center gap-1.5 py-2 pl-2 pr-1 text-[12px]"><Icon n="file" s={13} /><span className="truncate max-w-36">{file.name}</span></button>
          <button aria-label={'关闭文件 ' + file.name} onClick={() => closeTabs([file.path])} className="p-1 rounded hover:bg-[var(--hover)]"><Icon n="x" s={12} /></button>
        </div>)}</div>}
      </div>
      <div ref={statisticsAnchor}><IconBtn n="cpu" label="统计" active={statistics} onClick={() => setStatistics(!statistics)} /></div>
      <button className="status-action" aria-label={focus ? '返回对话' : '专注查看'} onClick={onFocus}><Icon n={focus ? 'panel' : 'expand'} s={15} />{focus && <span>返回对话</span>}</button>
      <IconBtn n="x" label="收起面板" onClick={onClose} />
    </header>
    {statistics && <Popover anchor={statisticsAnchor} onClose={() => setStatistics(false)} label="任务统计" width={360}><div className="p-3 space-y-4">{[['最近一轮用时', session.summaries.at(-1) ? (session.summaries.at(-1)!.durationMs / 1000).toFixed(1) + ' 秒' : '—'], ['上下文窗口', session.usage ? session.usage.contextWindow.toLocaleString() + ' Token' : '—'], ['当前上下文估算', session.usage ? session.usage.inputTokens.toLocaleString() + ' Token' : '—'], ['自动整理阈值', session.usage ? Math.floor(session.usage.thresholdTokens ?? session.usage.contextWindow * .8).toLocaleString() + ' Token' : '—'], ['累计 Token', session.usage ? (session.usage.totalInputTokens + session.usage.totalOutputTokens).toLocaleString() : '—'], ['文件变更', files.length + ' 个']].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-[var(--muted)]">{label}</span><span className="tabular-nums">{value}</span></div>)}{session.contextNotice && <div data-testid="compaction-statistics" className="rounded-xl border border-[var(--line)] p-3 text-[12px] leading-relaxed"><p className="font-medium">最近一次上下文整理</p><p className="mt-1 text-[var(--muted)]">整理前 {session.contextNotice.beforeTokens?.toLocaleString() ?? '—'} → 整理后 {session.contextNotice.afterTokens?.toLocaleString() ?? '—'} Token（会话记录）</p>{session.contextNotice.inputTokens !== undefined && <p className="text-[var(--muted)]">触发时总输入 {session.contextNotice.inputTokens.toLocaleString()} Token · 阈值 {session.contextNotice.thresholdTokens?.toLocaleString()} / 窗口 {session.contextNotice.contextWindow?.toLocaleString()}</p>}<p className="mt-1 text-[var(--muted)]">{session.contextNotice.message}</p></div>}</div></Popover>}
    {tabMenu && <Popover anchor={tabAnchor} onClose={() => setTabMenu(undefined)} label="文件标签操作" width={240} menu><div className="p-1">{[
      ['关闭标签', () => closeTabs([tabMenu])],
      ['关闭其他标签', () => closeTabs(view.tabs.filter(file => file.path !== tabMenu).map(file => file.path))],
      ['关闭右侧标签', () => closeTabs(view.tabs.slice(view.tabs.findIndex(file => file.path === tabMenu) + 1).map(file => file.path))],
    ].map(([label, action]) => <button key={String(label)} className="menu-row" onClick={() => { (action as () => void)(); setTabMenu(undefined) }}>{String(label)}</button>)}</div></Popover>}
    {view.section === 'mcp' && !active ? <McpResults key={id} session={session} onBrowser={browserActive => change(value => ({ ...value, section: 'browser', browserActive, active: null }))} /> : view.section === 'browser' && !active ? <Browser key={id} threadId={id} cwd={session.meta.cwd} activeId={view.browserActive} onActive={browserActive => change(value => ({ ...value, browserActive }))} onReference={onReference} /> : view.section === 'processes' && !active ? <Processes session={session} onError={onError} onOpenThread={onOpenThread} /> : view.section === 'issues' && !active ? <ErrorInspector onClose={onClose} session={session} requested={errorRequest} onOpenFile={open} /> : active ? <div data-testid="file-preview" className="flex flex-col flex-1 min-h-0">
      <div className="inspector-file-tools">
        <IconBtn n="chevron" label="返回产物列表" onClick={() => change(value => ({ ...value, active: null }))} className="rotate-180" />
        <span title={active.path.startsWith('attachment:') ? active.name : active.path} className="flex-1 min-w-0 truncate text-[12px] text-[var(--muted)]">{active.name}</span>
        {/\.html?$/i.test(active.path) && !active.path.startsWith('attachment:')&&!active.path.startsWith('source:') && <Btn onClick={() => { void store.api!.browser<{ id: string }>('open', { threadId: id, path: active.path }).then(result => { if (mounted.current) change(value => ({ ...value, section: 'browser', active: null, browserActive: result.id })) }).catch(error => onError(errorText(error))) }}>网页预览</Btn>}
        {/\.(doc|xls)$/i.test(active.name)&&!active.path.startsWith('source:')&&<Btn onClick={()=>void store.api!.artifacts('legacy-copy',{threadId:id,path:active.path,dark:document.documentElement.classList.contains('dark')}).catch(e=>onError(errorText(e)))}>转换为 Office 副本</Btn>}{active.path.startsWith('attachment:')&&<Btn onClick={()=>void store.api!.artifacts('attachment-copy',{threadId:id,path:active.path,dark:document.documentElement.classList.contains('dark')}).catch(e=>onError(errorText(e)))}>创建可编辑副本</Btn>}{!active.path.startsWith('attachment:')&&!active.path.startsWith('source:')&&active.kind!=='del'&&<Btn onClick={()=>void store.api!.artifacts('open',{threadId:id,path:active.path,dark:document.documentElement.classList.contains('dark')}).catch(e=>onError(errorText(e)))}>独立编辑与批注</Btn>}
        {active.diff && active.kind !== 'new' && <Btn v={showDiff ? 'soft' : 'ghost'} onClick={() => { change(value => ({ ...value, diff: { ...value.diff, [active.path]: true } })); setSource(false); setSelection(undefined) }}>变更 diff</Btn>}
        {active.kind !== 'del' && <Btn v={!showDiff && !source ? 'soft' : 'ghost'} onClick={() => { change(value => ({ ...value, diff: { ...value.diff, [active.path]: false } })); setSource(false); setSelection(undefined) }}>文件内容</Btn>}
        {!showDiff && preview && !preview.binary && preview.format !== 'image' && <Btn v={source ? 'soft' : 'ghost'} onClick={() => { setSource(!source); setSelection(undefined) }}>选择文本</Btn>}
        <Menu align="right" trigger={() => <IconBtn n="dots" label="文件操作" />} items={[
          { label: '刷新文件', icon: 'refresh', onClick: () => { setSelection(undefined); void load(active) } },
          ...(!active.path.startsWith('attachment:')&&!active.path.startsWith('source:') ? [
            { label: '复制文件路径', icon: 'copy', onClick: () => { void navigator.clipboard.writeText(active.path).catch(error => onError(errorText(error))) } },
            { label: '在资源管理器中显示', icon: 'folder', onClick: () => void reveal() },
          ] : []),
        ]} />
      </div>
      {stale && <div role="status" className="px-3 py-2 text-[11px] bg-[var(--accent-soft)] text-accent">文件有新的变更。当前保留阅读位置，可点击刷新查看最新内容。</div>}
      {source && <div className="px-3 py-2 text-[11px] text-[var(--muted)] border-b border-[var(--line)] flex items-center gap-2"><span className="flex-1">选中文本后加入当前对话。</span><Btn v="primary" disabled={!selection || selection.start === selection.end} onClick={reference}>{preview?.format && preview.format !== 'text' ? '引用文档选区' : '引用选区并修改'}</Btn></div>}
      <div ref={viewport} className="flex-1 overflow-auto min-h-0" onScroll={e => { const current = memory.get(id) ?? view; memory.set(id, { ...current, scroll: { ...current.scroll, [scrollKey]: e.currentTarget.scrollTop } }) }}>
        {showDiff && active.diff ? <div className="font-mono text-[11.5px] leading-[1.8] py-2">{active.diff.split('\n').map((line, i) => <div key={i} className={cx('flex px-2', line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', line.startsWith('-') && !line.startsWith('---') && 'bg-rose-500/10 text-rose-600 dark:text-rose-300')}><span className="w-8 shrink-0 text-right pr-2 text-[var(--muted)]/60 select-none">{i + 1}</span><span className="whitespace-pre">{line || ' '}</span></div>)}</div>
          : active.kind === 'del' ? <div className="p-5 text-[var(--muted)]">文件已删除，可在变更审查中查看或恢复。</div>
          : loading ? <div className="p-5 text-[var(--muted)]">正在读取文件…</div>
          : error ? <div role="alert" className="p-5 text-rose-500 break-words">{error}</div>
          : preview?.binary ? <div className="p-6 text-center"><FileIcon name={active.name} s={48} /><p className="my-4 text-[var(--muted)]">{preview.reason ?? '此格式请使用本机应用查看。'}</p><Btn v="outline" onClick={() => void reveal()}>在资源管理器中显示</Btn></div>
          : preview ? source ? <textarea aria-label="文件文本选区" readOnly value={preview.text} onSelect={e => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} className="block w-full min-h-full resize-none bg-transparent p-4 font-mono text-[12px] outline-none leading-relaxed" style={{ height: Math.max(320, preview.text.split('\n').length * 20 + 40) }} /> : preview.format && preview.format !== 'text' ? <DocumentView onFocus={onFocus} onFeedback={async (selection, note) => { const ref = await store.api!.feedback<ContextReference>('capture', { threadId:id,cwd: session.meta.cwd, path: active.path, digest: preview.digest, selection, note }); if (mounted.current) onReference(ref) }} preview={preview} name={active.name} position={position} onPosition={position => change(value => ({ ...value, documentPositions: { ...value.documentPositions, [active.path]: position } }))} /> : /\.md$/i.test(active.name) ? <div className="p-5"><Md text={preview.text} /></div> : <pre className="p-4 font-mono text-[12px] whitespace-pre-wrap break-all">{preview.text || '空文件'}</pre> : null}
      </div>
    </div> : <div data-testid="artifact-list" className="flex-1 overflow-auto p-2 min-h-0">
      {view.section === 'chg' ? <Review key={id} session={session} onOpenFile={open} onRestored={restored} onError={onError} /> : view.section === 'plan' ? <div data-testid="pinned-plan" className="p-3"><div className="flex items-center gap-2 px-2 mb-2"><h2 className="font-medium flex-1">执行计划</h2><Btn onClick={() => { onUnpinPlan(); change(value => ({ ...value, section: 'out' })) }}>取消固定</Btn></div>{plan ? <PlanSteps plan={plan} running={store.busy(id)} /> : <p className="p-3 text-[var(--muted)]">当前回合暂无执行计划。</p>}</div> : files.filter(f => f.kind !== 'del').length ? files.filter(f => f.kind !== 'del').map(file => <button key={file.path} onClick={() => open(file)} className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--hover)] text-left"><FileIcon name={file.name} s={30} /><div className="flex-1 min-w-0"><div className="font-medium truncate">{file.name}</div><div className="text-[11px] text-[var(--muted)] truncate">{file.path}</div></div><Icon n="chevron" s={13} /></button>) : <div className="py-16 text-center text-[var(--muted)]"><Icon n="spark" s={26} className="mx-auto mb-3 opacity-50" />任务生成的文件会出现在这里</div>}
    </div>}
  </aside>
}
