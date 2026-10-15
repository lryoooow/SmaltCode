import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Icon from './c/icons'
import Composer from './c/Composer'
import TaskView, { artifacts, type FileItem } from './c/Task'
import Panel from './c/Panel'
import TaskCenter from './c/TaskCenter'
import { sessionStatus } from './c/task-state'
import type { PreviewMemory } from './c/preview-state'
import SidebarContents from './c/Sidebar'
import ProjectDialog from './c/ProjectDialog'
import type { ConversationScrollMemory } from './c/useConversationScroll'
import { Modal, Onboarding, Palette, Settings, PROVIDER_NAMES } from './c/Overlays'
import { Btn, cx, IconBtn, Kbd, Logo, Menu, type Task } from './c/ui'
import { errorText, folderName, store, type Session, type ContextReference } from './bridge'

const EXAMPLES = [
  ['table', '整理这个文件夹里的发票，汇总成表格', '数据处理'],
  ['file', '把会议记录写成一份周报', '写作'],
  ['search', '找出所有合同中的违约条款并列出', '日常办公'],
  ['spark', '把这份 Excel 做成可视化图表', '数据处理'],
  ['terminal', '检查这个项目的问题，并给出修复建议', '编程'],
]
const SCENES = ['全部', '日常办公', '数据处理', '写作', '编程']
function preference<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem('smalt.ui.' + key); return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }
function savePreference(key: string, value: unknown) { try { localStorage.setItem('smalt.ui.' + key, JSON.stringify(value)) } catch { /* unavailable storage */ } }
function greet() { const h = new Date().getHours(); return h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好' }
function taskMeta(s: Session): Task {
  const date = new Date(s.meta.updatedAt); const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const age = today - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const status = sessionStatus(s)
  return { id: s.meta.id, title: s.meta.title, ws: folderName(s.meta.cwd), status, pinned: s.meta.pinned, projectId: s.meta.projectId,
    time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    group: s.meta.pinned ? '置顶' : ['running', 'approval', 'question'].includes(status) ? '进行中' : age <= 0 ? '今天' : age < 2 * 86400000 ? '昨天' : age < 7 * 86400000 ? '近 7 天' : '更早' }
}

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [dark, setDark] = useState(() => preference('dark', matchMedia('(prefers-color-scheme: dark)').matches))
  const [onboarding, setOnboarding] = useState(() => !preference('onboarded', false))
  const [cur, setCur] = useState<string | null>(null)
  const [page, setPage] = useState('tasks')
  const [notifications, setNotifications] = useState(() => preference('notifications', true))
  const [attention, setAttention] = useState(0)
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, ContextReference[]>>({})
  const previewMemory = useRef<PreviewMemory>(new Map())
  const activeView = useRef('')
  const [selectedProject, setSelectedProject] = useState<string>()
  const [projectDialog, setProjectDialog] = useState<string | 'new'>()
  const [deleting, setDeleting] = useState<{ kind: 'thread' | 'project'; id: string }>()
  const [side, setSide] = useState(() => preference('sidebar', true))
  const [panel, setPanel] = useState(true)
  const [sel, setSel] = useState<FileItem | null>(null)
  const [palette, setPalette] = useState(false)
  const [settings, setSettings] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => preference('drafts', {}))
  const [scene, setScene] = useState('全部')
  const [workspace, setWorkspace] = useState(() => preference('workspace', ''))
  const [workspaces, setWorkspaces] = useState<string[]>(() => preference('workspaces', []))
  const [homeModel, setHomeModel] = useState('')
  const [homeMode, setHomeMode] = useState('default')
  const [toast, setToast] = useState<string>()
  const [rename, setRename] = useState<string>()
  const [name, setName] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const scrollPositions = useRef<ConversationScrollMemory>(new Map())
  const flash = (text: string) => { clearTimeout(toastTimer.current); setToast(text); toastTimer.current = setTimeout(() => setToast(undefined), 5000) }
  useEffect(() => { void store.initialize(); return () => clearTimeout(toastTimer.current) }, [])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); savePreference('dark', dark) }, [dark])
  useEffect(() => { savePreference('sidebar', side) }, [side])
  useEffect(() => { savePreference('drafts', drafts) }, [drafts])
  useEffect(() => { for (const id of scrollPositions.current.keys()) if (!state.sessions[id]) scrollPositions.current.delete(id) }, [state.sessions])
  useEffect(() => { savePreference('workspace', workspace); savePreference('workspaces', workspaces) }, [workspace, workspaces])
  useEffect(() => {
    if (state.settings) {
      setHomeModel(state.settings.effective.defaultProvider + '/' + state.settings.effective.defaultModel)
      setHomeMode(state.settings.effective.permissionMode)
    }
  }, [state.settings])
  const session = cur ? state.sessions[cur] : undefined
  const activeProject = state.projects.find(p => p.id === (session ? session.meta.projectId : selectedProject))
  const tasks = Object.values(state.sessions).filter(s => !s.meta.archived).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)).map(taskMeta)
  const task = tasks.find(t => t.id === cur)
  const pending = tasks.filter(t => t.status === 'approval' || t.status === 'question').length
  const currentModel = session ? (session.meta.provider ?? state.settings?.effective.defaultProvider) + '/' + session.meta.model : homeModel
  const currentMode = session?.meta.permissionMode ?? homeMode
  const models = Object.entries(state.settings?.providers ?? {}).map(([id, config]) => ({ id: id + '/' + (id === state.settings?.effective.defaultProvider ? state.settings.effective.defaultModel : config.defaultModel ?? ''), label: (PROVIDER_NAMES[id] ?? id) + ' · ' + (id === state.settings?.effective.defaultProvider ? state.settings.effective.defaultModel : config.defaultModel ?? '') }))
  if (currentModel && !models.some(m => m.id === currentModel)) models.unshift({ id: currentModel, label: currentModel })
  const newTask = () => { store.select(null); setCur(null); setSel(null); setPage('tasks') }
  const open = async (id: string, jump = false) => {
    if (jump) { scrollPositions.current.delete(id); setAttention(value => value + 1) }
    setCur(id); setSelectedProject(store.getSnapshot().sessions[id]?.meta.projectId); setSel(null); setPage('tasks'); store.select(id)
    try { await store.open(id) } catch (err) { flash(errorText(err)) }
  }
  const pickFolder = async () => {
    try {
      const result = await store.api!.pickFolder(workspace || undefined)
      if (result.canceled) { if (result.reason) flash(result.reason); return }
      setWorkspace(result.dir); setWorkspaces(previous => [...new Set([result.dir, ...previous])].slice(0, 12))
    } catch (err) { flash(errorText(err)) }
  }
  useEffect(() => { store.select(page === 'tasks' ? cur : null); savePreference('notifications', notifications); void store.api?.activity?.(page === 'tasks' ? cur : null, notifications).catch(() => {}) }, [cur, page, notifications])
  useEffect(() => store.api?.onNavigate?.(id => { void open(id, true) }), [])
  const send = async (text: string) => {
    const provider = currentModel.split('/')[0]
    if (!state.settings?.providers[provider]?.hasKey && provider !== 'ollama') { setSettings(true); throw new Error('请先配置所选模型服务商的密钥') }
    const origin = activeView.current, key = draftKey, sentRefs = referenceDrafts[key] ?? []
    const scope = session?.meta.cwd ?? workspace
    const context = sentRefs.length ? await store.api!.resolveContext(scope, sentRefs) : { text: '', references: [] }
    const instruction = sentRefs.some(ref => ref.start !== undefined) ? '\n\n选区修改要求：优先仅修改用户引用的文本选区，保留其他内容；修改前重新读取文件，若需要扩大范围请先说明。' : ''
    const id = await store.send(cur, text, scope, currentModel, currentMode, activeProject?.id, { text: instruction + context.text, references: context.references })
    setReferenceDrafts(previous => ({ ...previous, [key]: (previous[key] ?? []).filter(ref => !sentRefs.includes(ref)) }))
    if (activeView.current === origin) { setCur(id); setPage('tasks') }
  }
  const changeModel = async (model: string) => {
    if (!cur) { setHomeModel(model); return }
    try { await store.updateThread(cur, { model }) } catch (err) { flash(errorText(err)) }
  }
  const changeMode = async (mode: string) => {
    if (!cur) { setHomeMode(mode); return }
    try { await store.updateThread(cur, { permissionMode: mode }) } catch (err) { flash(errorText(err)) }
  }
  const selectProject = (id: string) => {
    setSelectedProject(id); const project = state.projects.find(p => p.id === id)
    if (project?.cwd) setWorkspace(project.cwd)
    newTask()
  }
  const taskAction = (id: string, action: string, projectId?: string | null) => {
    const s = state.sessions[id]; if (!s) return
    if (action === 'rename') { setName(s.meta.title); setRename(id); return }
    if (action === 'delete') { setDeleting({ kind: 'thread', id }); return }
    const result = action === 'pin' ? store.updateThread(id, { pinned: !s.meta.pinned }, 'thread/pin') : action === 'move' ? store.updateThread(id, { projectId }, 'thread/project/update') : store.archive(id)
    void result.then(() => { if (action === 'archive' && cur === id) newTask() }).catch(err => flash(errorText(err)))
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      if (deleting.kind === 'thread') { const id = deleting.id; await store.delete(id); previewMemory.current.delete(id); setReferenceDrafts(previous => { const next = { ...previous }; delete next[id]; return next }); setDrafts(d => { const next = { ...d }; delete next[deleting.id]; return next }); if (cur === deleting.id) newTask() }
      else { await store.deleteProject(deleting.id); if (selectedProject === deleting.id) setSelectedProject(undefined) }
      setDeleting(undefined)
    } catch (err) { flash(errorText(err)) }
  }
  const doneOnboarding = () => { setOnboarding(false); savePreference('onboarded', true) }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || document.querySelector('[role="dialog"]')) return
      const key = event.key.toLowerCase()
      if (key === 'k') { event.preventDefault(); setPalette(p => !p) }
      if (key === 'b') { event.preventDefault(); setSide(p => !p) }
      if (key === 'j') { event.preventDefault(); setPanel(p => !p) }
      if (key === 'n') { event.preventDefault(); newTask() }
      if (key === ',') { event.preventDefault(); setSettings(true) }
    }
    addEventListener('keydown', handler); return () => removeEventListener('keydown', handler)
  }, [])
  const homeDraftKey = selectedProject ? 'project:' + selectedProject : 'home'
  const draftKey = cur ?? homeDraftKey
  activeView.current = page + ':' + draftKey
  const setReferences = (refs: ContextReference[]) => setReferenceDrafts(previous => ({ ...previous, [draftKey]: refs }))
  const reference = (ref: ContextReference) => {
    const current = referenceDrafts[draftKey] ?? []
    if (current.length >= 10) { flash('最多引用 10 项资料'); return }
    if (!current.some(item => item.path === ref.path && item.start === ref.start && item.end === ref.end)) setReferences([...current, ref])
    flash('选区已加入当前对话，请在输入框中说明修改要求。')
  }
  const setDraft = (value: string) => setDrafts(d => ({ ...d, [draftKey]: value }))
  const folders = [...new Set([...workspaces, ...Object.values(state.sessions).map(s => s.meta.cwd)])]
  const activeFiles = session ? artifacts(session) : []
  return <div className="h-full flex flex-col bg-[var(--bg)] relative">
    <div className="pointer-events-none absolute inset-0 overflow-hidden"><div className="absolute -top-60 left-1/4 size-[700px] rounded-full bg-[#4a6cf0]/[.07] dark:bg-[#4a6cf0]/[.10] blur-[120px]" /></div>
    <header className="titlebar relative z-20 h-[40px] shrink-0 flex items-center gap-1 px-2 select-none">
      <div className="flex items-center gap-2 px-2 mr-1"><Logo s={18} /><span className="text-[12px] font-semibold">SmaltCode</span></div>
      <IconBtn n="sidebar" label="切换侧边栏 (Ctrl+B)" onClick={() => setSide(!side)} />
      <div className="flex-1 flex justify-center items-center gap-2 min-w-0">{page !== 'tasks' ? <span className="text-[12px] font-medium">{{ activity: '任务中心', archives: '归档对话', workspaces: '工作区' }[page]}</span> : task && <div className="flex items-center gap-2 min-w-0 text-[12px]"><span className="font-medium truncate">{task.title}</span><span className="text-[var(--muted)] hidden lg:flex items-center gap-1"><Icon n="folder" s={12} />{task.ws}</span></div>}</div>
      <button onClick={() => setPalette(true)} className="h-7 w-52 hidden lg:flex items-center gap-2 px-2.5 rounded-lg bg-[var(--hover)] text-[var(--muted)] text-[12px] hover:text-[var(--text)]"><Icon n="search" s={13} />搜索任务或命令<span className="flex-1" /><Kbd>Ctrl K</Kbd></button>
      {page === 'tasks' && session && <IconBtn n="panel" label="切换右侧面板 (Ctrl+J)" onClick={() => setPanel(!panel)} active={panel} />}
      <Menu align="right" trigger={() => <IconBtn n="dots" label="更多" />} items={[
        ...(page === 'tasks' && session ? [
          { label: '重命名', icon: 'file', onClick: () => { setName(session.meta.title); setRename(session.meta.id) } },
          { label: session.meta.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => { void store.updateThread(session.meta.id, { pinned: !session.meta.pinned }, 'thread/pin').catch(err => flash(errorText(err))) } },
          { label: session.meta.archived ? '恢复对话' : '归档', icon: 'archive', disabled: store.busy(session.meta.id), onClick: () => { void (session.meta.archived ? store.restore(session.meta.id) : store.archive(session.meta.id).then(newTask)).catch(err => flash(errorText(err))) } },
          ...state.projects.map(p => ({ label: '移至 ' + p.name, icon: 'folder', disabled: store.busy(session.meta.id), onClick: () => taskAction(session.meta.id, 'move', p.id) })),
          { label: '移出项目', icon: 'chat', disabled: store.busy(session.meta.id), onClick: () => taskAction(session.meta.id, 'move', null) },
          { label: '删除对话', icon: 'trash', danger: true, disabled: store.busy(session.meta.id), onClick: () => setDeleting({ kind: 'thread', id: session.meta.id }) }, { label: '-' },
        ] : []), { label: '重新查看引导', icon: 'info', onClick: () => setOnboarding(true) },
      ]} />
      {store.api && <div className="window-buttons flex ml-2">{(['minimize', 'maximize', 'close'] as const).map((action, index) => <button key={action} aria-label={['最小化', '最大化或还原', '隐藏到托盘'][index]} onClick={() => void store.api!.windowControl(action)} className={cx('w-10 h-8 grid place-items-center rounded', action === 'close' ? 'hover:bg-rose-600 hover:text-white' : 'hover:bg-[var(--hover)]')}><svg width="11" height="11" fill="none" stroke="currentColor"><path d={index === 0 ? 'M1 6h9' : index === 1 ? 'M1.5 1.5h8v8h-8z' : 'M1 1l9 9M10 1l-9 9'} /></svg></button>)}</div>}
    </header>
    <div className="relative z-10 flex-1 flex min-h-0">
      <aside data-testid="sidebar" className={cx('shrink-0 flex flex-col transition-[width] duration-200 overflow-hidden', side ? 'w-[236px]' : 'w-[56px]')}>
        <div className="px-2.5 pt-1 pb-2"><button aria-label="新建任务" onClick={() => { setSelectedProject(undefined); newTask() }} className={cx('w-full h-9 flex items-center gap-2.5 rounded-xl font-medium transition', side ? 'px-2.5 bg-[var(--surface-solid)] border border-[var(--line)] shadow-sm hover:shadow-md' : 'justify-center hover:bg-[var(--hover)]')}><Logo s={20} />{side && <><span>新建任务</span><span className="flex-1" /><span className="text-[10px] text-[var(--muted)] font-normal">Ctrl N</span></>}</button></div>
        <nav className="px-2.5 space-y-0.5">{[['chat', '对话', 'tasks'], ['list', '任务中心', 'activity'], ['folder', '工作区', 'workspaces'], ['archive', '归档对话', 'archives']].map(([icon, label, id]) => <button key={id} title={label} onClick={() => setPage(id)} className={cx('w-full h-8 flex items-center gap-2.5 rounded-lg text-[13px]', side ? 'px-2.5' : 'justify-center', page === id ? 'font-medium text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--hover)]')}><Icon n={icon} s={16} />{side && <><span>{label}</span><span className="flex-1" />{id === 'tasks' && pending > 0 && <span className="text-[10px] min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white grid place-items-center">{pending}</span>}</>}</button>)}
          {side && <div className="flex gap-2 px-2.5 pt-2 text-[10.5px] text-[var(--muted)]/70"><span>技能</span><span>·</span><span>连接器</span><span>·</span><span>定时任务筹备中</span></div>}
        </nav>
        {side ? <SidebarContents tasks={tasks} projects={state.projects} current={page === 'tasks' ? cur : null} project={selectedProject} loading={state.loading} busy={id => store.busy(id)} onOpen={id => void open(id)} onProject={selectProject} onNewProject={() => setProjectDialog('new')} onEditProject={setProjectDialog} onDeleteProject={id => setDeleting({ kind: 'project', id })} onTask={taskAction} /> : <div className="flex-1" />}
        <div className={cx('p-2.5 flex items-center gap-1 border-t border-[var(--line)]/60', !side && 'flex-col')}>
          <div className="size-7 rounded-full bg-[var(--accent-soft)] grid place-items-center text-accent"><Icon n="user" s={14} /></div>{side && <div className="flex-1 min-w-0 leading-tight ml-1"><div className="text-[12px] font-medium">本机工作空间</div><div className="text-[10.5px] text-[var(--muted)]">v{store.api?.version ?? '—'}</div></div>}
          <IconBtn n={dark ? 'sun' : 'moon'} label="切换主题" onClick={() => setDark(!dark)} /><IconBtn n="gear" label="设置 (Ctrl+,)" onClick={() => setSettings(true)} />
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col rounded-tl-2xl border-t border-l border-[var(--line)] bg-[var(--surface)] backdrop-blur-xl overflow-hidden">
        {state.error && <div data-testid="connection-error" role="alert" className="p-3 bg-rose-500/10 text-rose-600 flex items-center gap-3 shrink-0"><Icon n="alert" s={16} /><span className="flex-1 break-words">{state.error}</span>{store.api && <Btn v="outline" onClick={() => void store.initialize()}>重新连接</Btn>}</div>}
        {page === 'activity' ? <TaskCenter sessions={Object.values(state.sessions)} notifications={notifications} setNotifications={setNotifications} onOpen={id => void open(id, true)} onError={flash} /> : page === 'archives' ? <div data-testid="archives" className="overflow-auto p-8 lg:p-12"><h1 className="text-[24px] font-semibold">归档对话</h1><p className="text-[var(--muted)] mt-2">归档保留内容，可以随时恢复。</p><div className="max-w-3xl mt-8 space-y-3">{Object.values(state.sessions).filter(s => s.meta.archived).map(s => <div key={s.meta.id} data-testid="archived-row" className="flex items-center gap-3 p-4 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]"><Icon n="archive" s={18} className="text-[var(--muted)]" /><button onClick={() => void open(s.meta.id)} className="min-w-0 flex-1 text-left"><span className="block font-medium truncate">{s.meta.title}</span><span className="text-[11px] text-[var(--muted)]">{folderName(s.meta.cwd)}</span></button><Btn v="outline" onClick={() => void store.restore(s.meta.id).catch(e => flash(errorText(e)))}>恢复对话</Btn><IconBtn n="trash" label={'删除对话 ' + s.meta.title} onClick={() => setDeleting({ kind: 'thread', id: s.meta.id })} /></div>)}{!Object.values(state.sessions).some(s => s.meta.archived) && <div className="py-12 text-[var(--muted)]">暂无归档对话。</div>}</div></div>
          : page === 'workspaces' ? <div data-testid="workspaces" className="overflow-auto p-8 lg:p-12"><div className="flex items-center justify-between max-w-3xl"><div><h1 className="text-[24px] font-semibold">工作区</h1><p className="text-[var(--muted)] mt-2">每个任务都在独立的工作文件夹中进行。</p></div><Btn v="primary" disabled={!state.connected} onClick={() => void pickFolder()}><Icon n="plus" s={14} />添加文件夹</Btn></div><div className="max-w-3xl mt-8 grid grid-cols-1 lg:grid-cols-2 gap-4">{folders.length ? folders.map(dir => <button key={dir} onClick={() => { setWorkspace(dir); newTask() }} className={cx('p-5 border rounded-2xl bg-[var(--surface-solid)] text-left hover:shadow-md transition', dir === workspace ? 'border-accent/50' : 'border-[var(--line)]')}><Icon n="folder" s={26} className="text-accent" /><div className="text-[15px] font-medium mt-4">{folderName(dir)}</div><div className="text-[11px] text-[var(--muted)] mt-1 break-all">{dir}</div><div className="text-[12px] text-[var(--muted)] mt-4">{Object.values(state.sessions).filter(s => s.meta.cwd === dir).length} 个任务</div></button>) : <div className="py-12 text-[var(--muted)]">添加一个资料或项目文件夹开始工作。</div>}</div></div>
          : session ? <div className="flex flex-1 min-h-0"><TaskView references={referenceDrafts[draftKey] ?? []} onReferencesChange={setReferences} key={session.meta.id + ':' + attention} session={session} scrollPositions={scrollPositions.current} onOpenFile={file => { setSel(file); setPanel(true) }} model={currentModel} setModel={model => void changeModel(model)} models={models} mode={currentMode} setMode={mode => void changeMode(mode)} draft={drafts[draftKey] ?? ''} setDraft={setDraft} onSend={send} onError={flash} onSettings={() => setSettings(true)} />{panel && <Panel key={session.meta.id} memory={previewMemory.current} onReference={reference} session={session} files={activeFiles} sel={sel} setSel={setSel} onClose={() => { setPanel(false); setSel(null) }} onError={flash} />}</div>
          : <div data-testid="home" className="flex-1 overflow-y-auto"><div className="max-w-[640px] mx-auto px-8 pt-[11vh] pb-10">
            <div className="anim-rise text-center"><div className="inline-flex"><Logo s={44} /></div><h1 className="mt-5 text-[28px] font-semibold tracking-tight">{activeProject?.name ?? greet()}</h1><p className="mt-1.5 text-[var(--muted)] text-[14px]">{activeProject ? '项目内的对话将共用你的项目说明。' : '今天想把什么工作交给我？'}</p>{activeProject && <div className="mt-3 flex items-center justify-center gap-2"><Btn v="outline" onClick={() => setProjectDialog(activeProject.id)}><Icon n="file" s={13} />编辑项目</Btn><Btn v="ghost" onClick={() => { setSelectedProject(undefined); newTask() }}>返回所有对话</Btn></div>}</div>
            <div className="mt-6 flex justify-center gap-1">{SCENES.map(s => <button key={s} onClick={() => setScene(s)} className={cx('h-7 px-3 rounded-full text-[12px] transition', scene === s ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--muted)] hover:bg-[var(--hover)]')}>{s}</button>)}</div>
            <div className="mt-4"><Composer key={homeDraftKey} ws={workspace} references={referenceDrafts[homeDraftKey] ?? []} onReferencesChange={refs => setReferenceDrafts(previous => ({ ...previous, [homeDraftKey]: refs }))} big disabled={!state.connected} value={drafts[homeDraftKey] ?? ''} setValue={value => setDrafts(d => ({ ...d, [homeDraftKey]: value }))} onSend={send} mode={homeMode} setMode={mode => void changeMode(mode)} model={homeModel} setModel={model => void changeModel(model)} models={models} onError={flash} />
              <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-[var(--muted)] px-1">在<Menu trigger={() => <button aria-label="选择工作文件夹" title={workspace} disabled={!state.connected} className="h-6 px-2 flex items-center gap-1 rounded-md bg-[var(--hover)] text-[var(--text)] font-medium hover:bg-[var(--accent-soft)]"><Icon n="folder" s={13} className="text-accent" /><span className="max-w-52 truncate">{workspace ? folderName(workspace) : '选择工作文件夹'}</span><Icon n="down" s={11} /></button>} items={[...folders.map(dir => ({ label: folderName(dir), desc: dir, icon: 'folder', sel: dir === workspace, onClick: () => setWorkspace(dir) })), ...(folders.length ? [{ label: '-' }] : []), { label: '选择其他文件夹…', icon: 'plus', onClick: () => void pickFolder() }]} />中工作</div>
            </div>
            <div className="mt-8 grid grid-cols-2 gap-2.5">{EXAMPLES.filter(e => scene === '全部' || e[2] === scene).slice(0, 4).map(([icon, text, category]) => <button key={text} onClick={() => setDrafts(d => ({ ...d, [homeDraftKey]: text }))} className="group p-3.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]/70 text-left hover:bg-[var(--surface-solid)] hover:border-accent/30 hover:-translate-y-0.5 hover:shadow-md transition"><div className="flex items-center justify-between"><span className="size-7 rounded-lg bg-[var(--accent-soft)] text-accent grid place-items-center"><Icon n={icon} s={15} /></span><span className="text-[11px] text-[var(--muted)]">{category}</span></div><div className="mt-2.5 leading-snug">{text}</div></button>)}</div>
            <p className="mt-9 text-center text-[11px] text-[var(--muted)]/80">内容由 AI 生成，请核实重要信息</p>
          </div></div>}
      </main>
    </div>
    <footer className="relative z-10 h-[24px] shrink-0 flex items-center gap-4 px-3 text-[11px] text-[var(--muted)] border-t border-[var(--line)] bg-[var(--surface-solid)]/70"><span className="flex items-center gap-1.5"><span className={cx('size-1.5 rounded-full', state.connected ? 'bg-emerald-500' : state.loading ? 'bg-amber-500' : 'bg-rose-500')} />{state.connected ? '内核已连接' : state.loading ? '连接中…' : '内核未连接'}</span><span className="flex items-center gap-1 min-w-0"><Icon n="cpu" s={11} /><span className="truncate max-w-52">{currentModel.split('/').slice(1).join('/') || '—'}</span></span>{session?.usage && <span>上下文 {Math.round(session.usage.contextUsage * 100)}%</span>}<span className="flex-1" />{tasks.some(t => t.status === 'running') && <span className="text-accent">{tasks.filter(t => t.status === 'running').length} 个任务运行中</span>}{pending > 0 && <span className="text-amber-600 dark:text-amber-400">{pending} 项待处理</span>}</footer>
    {toast && <div role="status" className="fixed top-14 left-1/2 -translate-x-1/2 z-[95] max-w-[80vw] px-4 py-2 flex items-center gap-2 rounded-xl bg-[var(--text)] text-[var(--bg)] shadow-xl text-[12px]"><Icon n="info" s={14} /><span className="break-words">{toast}</span><button aria-label="关闭提示" onClick={() => setToast(undefined)}><Icon n="x" s={12} /></button></div>}
    {palette && <Palette tasks={tasks} onClose={() => setPalette(false)} onPick={id => void open(id)} actions={[{ label: '新建任务', icon: 'plus', k: 'Ctrl N', run: newTask }, { label: '打开任务中心', icon: 'list', k: '', run: () => setPage('activity') }, { label: '打开设置', icon: 'gear', k: 'Ctrl ,', run: () => setSettings(true) }, { label: '切换深色模式', icon: 'moon', k: '', run: () => setDark(d => !d) }, { label: '选择工作文件夹', icon: 'folder', k: '', run: () => void pickFolder() }]} />}
    {settings && state.settings && <Settings settings={state.settings} onClose={() => setSettings(false)} dark={dark} setDark={setDark} />}
    {onboarding && state.connected && <Onboarding onDone={doneOnboarding} onSettings={() => setSettings(true)} onPickFolder={pickFolder} workspace={workspace} configured={!!state.settings?.providers[state.settings.effective.defaultProvider]?.hasKey} />}
    {projectDialog && <ProjectDialog project={state.projects.find(p => p.id === projectDialog)} workspace={workspace} onClose={() => setProjectDialog(undefined)} onSaved={p => { setProjectDialog(undefined); setSelectedProject(p.id); if (p.cwd) setWorkspace(p.cwd); newTask() }} onError={flash} />}
    {deleting && <Modal onClose={() => setDeleting(undefined)} label={deleting.kind === 'thread' ? '删除对话' : '删除项目'} w="w-[420px]"><div className="p-6"><h2 className="text-[18px] font-semibold">{deleting.kind === 'thread' ? '删除这段对话？' : '删除这个项目？'}</h2><p className="text-[var(--muted)] mt-3 leading-relaxed">{deleting.kind === 'thread' ? '对话历史将永久删除，工作文件夹中的实际文件会保留。' : '项目说明和分组将删除，对话会移回普通列表，内容保留。'}</p><div className="flex justify-end gap-2 mt-6"><Btn onClick={() => setDeleting(undefined)}>取消</Btn><Btn v="danger" onClick={() => void confirmDelete()}>确认删除</Btn></div></div></Modal>}
    {rename && <Modal onClose={() => setRename(undefined)} label="重命名任务" w="w-[420px]"><form className="p-6" onSubmit={event => { event.preventDefault(); void store.updateThread(rename, { title: name }, 'thread/rename').then(() => setRename(undefined)).catch(err => flash(errorText(err))) }}><h2 className="text-[17px] font-semibold mb-4">重命名任务</h2><input autoFocus aria-label="任务名称" maxLength={120} value={name} onChange={e => setName(e.target.value)} className="field w-full" /><div className="flex justify-end gap-2 mt-5"><Btn type="button" onClick={() => setRename(undefined)}>取消</Btn><Btn type="submit" v="primary" disabled={!name.trim()}>保存</Btn></div></form></Modal>}
  </div>
}
