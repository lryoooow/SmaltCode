import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Icon from './c/icons'
import Composer from './c/Composer'
import { modelChoices } from './c/model-choices'
import TaskView, { artifacts, type FileItem } from './c/Task'
import Panel from './c/Panel'
import WorkspaceSplit from './c/WorkspaceSplit'
import { emptyInspector, type InspectorLayout } from './c/inspector-layout'
import TaskCenter from './c/TaskCenter'
import Skills from './c/Skills'
import Integrations from './c/Integrations'
import Autonomy from './c/Autonomy'
import Collaborations from './c/Collaborations'
import Remote, { selectSshEntry } from './c/Remote'
import Overview from './c/Overview'
import { sessionStatus } from './c/task-state'
import type { BrowserPreviewRequest, PreviewMemory } from './c/preview-state'
import SidebarContents from './c/Sidebar'
import ProjectDialog from './c/ProjectDialog'
import NewChatContext from './c/NewChatContext'
import FileContextPanel from './c/FileContextPanel'
import type { FileContextView } from '../../shared/file-context'
import { workLocation } from './c/work-location'
import type { ConversationScrollMemory } from './c/useConversationScroll'
import { Modal, Onboarding, Palette, Settings, PROVIDER_NAMES } from './c/Overlays'
import { Btn, cx, IconBtn, Kbd, Logo, Menu, type Task } from './c/ui'
import { errorText, folderName, store, type Session, type ContextReference, type ProjectMeta } from './bridge'

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
  return { id: s.meta.id, title: s.meta.title, ws: workLocation(s.meta).label, status, pinned: s.meta.pinned, projectId: s.meta.projectId,
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
  const [processRequests, setProcessRequests] = useState<Record<string, number>>({})
  const [errorRequests, setErrorRequests] = useState<Record<string, { id: string; sequence: number }>>({})
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, ContextReference[]>>({})
  const previewMemory = useRef<PreviewMemory>(new Map())
  const activeView = useRef('')
  const navigation = useRef(0)
  const [selectedProject, setSelectedProject] = useState<string>()
  const [projectResourcesRevision,setProjectResourcesRevision]=useState(0)
  const [projectDialog, setProjectDialog] = useState<string | 'new'>()
  const [deleting, setDeleting] = useState<{ kind: 'thread' | 'project'; id: string }>()
  const [side, setSide] = useState(() => preference('sidebar', true))
  const [browserRequests, setBrowserRequests] = useState<Record<string, BrowserPreviewRequest>>({})
  useEffect(() => store.api?.onBrowserShortcut?.(value => { dispatchEvent(new KeyboardEvent('keydown', { key: value.key, ctrlKey: value.control, shiftKey: value.shift, cancelable: true })) }), [])
  const [panelLayouts, setPanelLayouts] = useState<Record<string, InspectorLayout>>({})
  const panelThread = useRef(cur); panelThread.current = cur
  const defaultPanelWidth = useRef(preference('panelWidth', 480))
  const panelLayout = cur ? panelLayouts[cur] ?? emptyInspector(defaultPanelWidth.current) : emptyInspector()
  const panel = panelLayout.open
  const changePanel = useCallback((change: (layout: InspectorLayout) => InspectorLayout) => {
    const id = panelThread.current; if (!id) return
    setPanelLayouts(before => ({ ...before, [id]: change(before[id] ?? emptyInspector(defaultPanelWidth.current)) }))
  }, [])
  const setPanel = useCallback((value: boolean | ((open: boolean) => boolean)) => changePanel(before => ({ ...before, open: typeof value === 'function' ? value(before.open) : value })), [changePanel])
  useEffect(() => { const timer = setTimeout(() => { defaultPanelWidth.current = panelLayout.width; savePreference('panelWidth', panelLayout.width) }, 200); return () => clearTimeout(timer) }, [panelLayout.width])
  const pinPlan = () => { setResources(v=>({...v,[cur??'home']:false})); changePanel(before => ({ ...before, open: true, planPinned: true, planRequest: before.planRequest + 1 })) }
  const [sel, setSel] = useState<FileItem | null>(null)
  const [palette, setPalette] = useState(false)
  const [settings, setSettings] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => preference('drafts', {}))
  const [scene, setScene] = useState('全部')
  const [fileView,setFileView]=useState<FileContextView & {projectDefault?:string}>()
  const [resources,setResources]=useState<Record<string,boolean>>({})
  const [homeLayout,setHomeLayout]=useState<InspectorLayout>(()=>emptyInspector(440))
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const [managedWorkspace, setManagedWorkspace] = useState('')
  const [spaceError, setSpaceError] = useState('')
  const managedDrafts = useRef(new Map<string, Promise<string>>())
  const pendingNewDrafts = useRef(new Set<string>())
  const currentDraftId = useRef(draftId); currentDraftId.current = draftId
  const ensureLocalSpace = (id: string) => {
    let pending = managedDrafts.current.get(id)
    if (!pending) {
      pending = store.api?.localSpace ? store.api.localSpace('create').then(value => value.cwd) : Promise.reject(new Error('请重新打开最新免安装版，以启用自动本地存储'))
      managedDrafts.current.set(id, pending)
      void pending.catch(() => { if (managedDrafts.current.get(id) === pending) managedDrafts.current.delete(id) })
    }
    return pending
  }
  const draftProject = state.projects.find(project => project.id === selectedProject)
  const linkedWorkspace = fileView?.scope===managedWorkspace && fileView.cwd!==managedWorkspace ? fileView.cwd : ''
  const workspace = linkedWorkspace || managedWorkspace
  const [homeModel, setHomeModel] = useState('')
  const [homeMode, setHomeMode] = useState('default')
  const [toast, setToast] = useState<string>()
  const [rename, setRename] = useState<string>()
  const [name, setName] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const scrollPositions = useRef<ConversationScrollMemory>(new Map())
  const flash = (text: string) => { clearTimeout(toastTimer.current); setToast(text); toastTimer.current = setTimeout(() => setToast(undefined), 5000) }
  useEffect(() => { void store.initialize(); return () => { clearTimeout(toastTimer.current); store.dispose() } }, [])
  useEffect(() => {
    if (cur || !state.connected) return
    let alive = true; setSpaceError('')
    void ensureLocalSpace(draftId).then(cwd => { if (alive) setManagedWorkspace(cwd) }).catch(error => { if (alive) setSpaceError(errorText(error)) })
    return () => { alive = false }
  }, [draftId, cur, state.connected])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); savePreference('dark', dark) }, [dark])
  useEffect(() => { savePreference('sidebar', side) }, [side])
  const latestDrafts = useRef(drafts); latestDrafts.current = drafts
  useEffect(() => { const timer = setTimeout(() => savePreference('drafts', drafts), 350); return () => clearTimeout(timer) }, [drafts])
  useEffect(() => { const flush = () => savePreference('drafts', latestDrafts.current); addEventListener('pagehide', flush); return () => { removeEventListener('pagehide', flush); flush() } }, [])
  useEffect(()=>store.api?.onArtifactSelection?.(v=>{const session=store.getSnapshot().sessions[v.threadId];if(!session||session.meta.archived||typeof v.text!=='string'||v.text.length>64000)return;setDrafts(old=>({...old,[v.threadId]:(old[v.threadId]?old[v.threadId]+'\n\n':'')+v.text}));flash('Word 选段已加入所属对话草稿，请核对后发送')}),[])
  const referenceWorkspaces = useRef(new Map<string, string>())
  useEffect(() => {
    if (cur) return
    const key = 'home', before = referenceWorkspaces.current.get(key)
    referenceWorkspaces.current.set(key, workspace)
    if (before !== undefined && before !== workspace) setReferenceDrafts(previous => ({ ...previous, [key]: (previous[key] ?? []).filter(ref => ref.path.startsWith('attachment:') || ref.path.startsWith('skill:') || ref.path.startsWith('source:')) }))
  }, [workspace, selectedProject, cur])
  useEffect(() => { for (const id of scrollPositions.current.keys()) if (!state.sessions[id]) scrollPositions.current.delete(id) }, [state.sessions])
  useEffect(() => {
    if (state.settings) {
      setHomeModel(state.settings.effective.defaultProvider + '/' + state.settings.effective.defaultModel)
      setHomeMode(state.settings.effective.permissionMode)
    }
  }, [state.settings?.effective.defaultProvider, state.settings?.effective.defaultModel, state.settings?.effective.permissionMode])
  const session = cur ? state.sessions[cur] : undefined
  const activeProject = state.projects.find(p => p.id === (session ? session.meta.projectId : selectedProject))
  const tasks = Object.values(state.sessions).filter(s => !s.meta.archived && !s.meta.collaboration).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)).map(taskMeta)
  const task = tasks.find(t => t.id === cur)
  const pending = tasks.filter(t => t.status === 'approval' || t.status === 'question').length
  const currentModel = session ? (session.meta.provider ?? state.settings?.effective.defaultProvider) + '/' + session.meta.model : homeModel
  const currentMode = session?.meta.permissionMode ?? homeMode
  const models = useMemo(() => modelChoices(state.settings, currentModel), [state.settings, currentModel])
  const showNewDraft = () => { navigation.current++; managedDrafts.current.clear(); setDraftId(crypto.randomUUID()); setManagedWorkspace(''); setFileView(undefined); store.select(null); setCur(null); setSel(null); setPage('tasks') }
  const newTask = () => {
    setSelectedProject(undefined)
    setFileView(undefined)
    showNewDraft()
  }
  const beginProject = (project: ProjectMeta) => {
    setSelectedProject(project.id)
    if (cur || page !== 'tasks') { setFileView(undefined); showNewDraft() } else if (pendingNewDrafts.current.has(draftId)) showNewDraft(); else navigation.current++
  }
  const open = async (id: string, jump = false) => {
    navigation.current++
    if (jump) { scrollPositions.current.delete(id); setAttention(value => value + 1) }
    setCur(id); setSelectedProject(store.getSnapshot().sessions[id]?.meta.projectId); setSel(null); setPage('tasks'); store.select(id)
    try { await store.open(id) } catch (err) { flash(errorText(err)) }
  }
  const clearProject = () => { setSelectedProject(undefined); if (pendingNewDrafts.current.has(draftId)) showNewDraft(); else navigation.current++ }
  const retryLocalSpace = () => { const id = draftId; managedDrafts.current.delete(id); setSpaceError(''); void ensureLocalSpace(id).then(cwd => { if (currentDraftId.current === id) setManagedWorkspace(cwd) }).catch(error => { if (currentDraftId.current === id) setSpaceError(errorText(error)) }) }
  const showResources=()=>{setResources(v=>({...v,[cur??'home']:true}));if(cur)setPanel(true);else setHomeLayout(v=>({...v,open:true}))}
  const pickFolder = async () => { setPage('tasks');showResources() }
  useEffect(()=>{if(cur||!managedWorkspace||!store.api?.fileContext)return;let alive=true;const scope=managedWorkspace;void store.api.fileContext<FileContextView & {projectDefault?:string}>('apply-project',{scope,projectId:selectedProject}).then(v=>{if(alive){setFileView(v);setSpaceError('')}}).catch(e=>{if(alive)setSpaceError(errorText(e))});return()=>{alive=false}},[managedWorkspace,selectedProject,cur,projectResourcesRevision])
  useEffect(() => { store.select(page === 'tasks' ? cur : null); savePreference('notifications', notifications); void store.api?.activity?.(page === 'tasks' ? cur : null, notifications).catch(() => {}) }, [cur, page, notifications])
  useEffect(() => store.api?.onNavigate?.(id => { void open(id, true) }), [])
  const send = async (text: string) => {
    const provider = currentModel.split('/')[0]
    if (!state.settings?.providers[provider]?.hasKey && provider !== 'ollama') { setSettings(true); throw new Error('请先配置所选模型服务商的密钥') }
    const origin = activeView.current, epoch = navigation.current, key = draftKey, sentRefs = referenceDrafts[key] ?? []
    const threadId = page === 'tasks' && session ? cur : null
    if (!threadId) pendingNewDrafts.current.add(draftId)
    try {
    const fileScope = threadId ?? await ensureLocalSpace(draftId)
    const environment = !threadId && store.api!.fileContext ? await store.api!.fileContext<FileContextView>('get',{scope:fileScope}) : undefined
    const scope = threadId ? session!.meta.cwd : environment?.cwd ?? fileScope
    const context = sentRefs.length ? await store.api!.resolveContext(scope, sentRefs,threadId??undefined,fileScope) : { text: '', references: [], images: [] }
    const documentSelection = sentRefs.some(ref => (ref.start !== undefined || ref.path.startsWith('feedback:')) && /\.(?:pdf|docx|xlsx)(?:$|:| ·)/i.test(ref.label ?? ref.path))
    const instruction = documentSelection ? '\n\n用户引用的是文档提取文字或单元格快照，仅用于分析或提供改写内容。不要用纯文本写入或补丁覆盖 PDF/Office 二进制原件。需要新建文档时先说明输出格式。' : sentRefs.some(ref => ref.start !== undefined) ? '\n\n选区修改要求：优先仅修改用户引用的文本选区，保留其他内容；修改前重新读取文件，若需要扩大范围请先说明。' : ''
    const id = await store.send(threadId, text, scope, currentModel, currentMode, activeProject?.id, { text: instruction + context.text, references: context.references, images: context.images, fileScope:threadId?undefined:fileScope })
    setReferenceDrafts(previous => ({ ...previous, [key]: (previous[key] ?? []).filter(ref => !sentRefs.includes(ref)) }))
    if (activeView.current === origin && navigation.current === epoch) { store.select(id); setCur(id); setPage('tasks') } else if(!threadId && currentDraftId.current===draftId){setDraftId(crypto.randomUUID());setManagedWorkspace('');setFileView(undefined)}
    } finally { if (!threadId) pendingNewDrafts.current.delete(draftId) }
  }
  const changeModel = async (model: string) => {
    const slash = model.indexOf('/'); if (slash > 0) void store.loadModels(model.slice(0, slash), false, model.slice(slash + 1)).catch(() => {})
    if (!cur) { setHomeModel(model); return }
    try { await store.updateThread(cur, { model }) } catch (err) { flash(errorText(err)) }
  }
  const changeMode = async (mode: string) => {
    if (!cur) { setHomeMode(mode); return }
    try { await store.updateThread(cur, { permissionMode: mode }) } catch (err) { flash(errorText(err)) }
  }
  const selectProject = (id: string) => {
    const project = store.getSnapshot().projects.find(p => p.id === id)
    if (!project) { flash('项目已不存在，请重新选择'); return }
    beginProject(project)
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
  const homeDraftKey = 'home'
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
  const activeFiles = useMemo(() => session ? artifacts(session) : [], [session?.items, session?.meta.cwd])
  return <div className="h-full flex flex-col bg-[var(--bg)] relative">

    <header className="titlebar relative z-20 h-[40px] shrink-0 flex items-center gap-1 px-2 select-none">
      <div className="flex items-center gap-2 px-2 mr-1"><Logo s={18} /><span className="text-[12px] font-semibold">SmaltCode</span>{store.api?.developmentPreview && <span className="text-[10px] text-accent bg-[var(--accent-soft)] rounded px-1.5 py-0.5">开发预览</span>}</div>
      <IconBtn n="sidebar" label="切换侧边栏 (Ctrl+B)" onClick={() => setSide(!side)} />
      <div className="flex-1 flex justify-center items-center gap-2 min-w-0">{page !== 'tasks' ? <span className="text-[12px] font-medium">{{ activity: '任务中心', archives: '归档对话', workspaces: '工作区' }[page]}</span> : task && <div className="flex items-center gap-2 min-w-0 text-[12px]"><span className="font-medium truncate">{task.title}</span><span className="text-[var(--muted)] hidden lg:flex items-center gap-1"><Icon n="folder" s={12} />{task.ws}</span></div>}</div>
      <button onClick={() => setPalette(true)} className="h-7 w-52 hidden lg:flex items-center gap-2 px-2.5 rounded-lg bg-[var(--hover)] text-[var(--muted)] text-[12px] hover:text-[var(--text)]"><Icon n="search" s={13} />搜索任务或命令<span className="flex-1" /><Kbd>Ctrl K</Kbd></button>
      {page === 'tasks' && <IconBtn n="folder" label="打开资料与产物" onClick={showResources} active={!!resources[cur??'home']&&(cur?panel:homeLayout.open)} />}
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
        <nav className="px-2.5 space-y-0.5">{[['chat', '对话', 'tasks'], ['list', '任务中心', 'activity'], ['spark', '技能', 'skills'], ['cpu', '连接器与插件', 'integrations'], ['clock', '持续任务', 'autonomy'], ['branch', '协作任务', 'collaborations'], ['globe', '远程连接', 'remote'], ['cpu', '用量与诊断', 'overview'], ['archive', '归档对话', 'archives']].map(([icon, label, id]) => <button key={id} title={label} onClick={() => setPage(id)} className={cx('w-full h-8 flex items-center gap-2.5 rounded-lg text-[13px]', side ? 'px-2.5' : 'justify-center', page === id ? 'font-medium text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--hover)]')}><Icon n={icon} s={16} />{side && <><span>{label}</span><span className="flex-1" />{id === 'tasks' && pending > 0 && <span className="text-[10px] min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white grid place-items-center">{pending}</span>}</>}</button>)}
        </nav>
        {side ? <SidebarContents tasks={tasks} projects={state.projects} current={page === 'tasks' ? cur : null} project={selectedProject} loading={state.loading} busy={id => store.busy(id)} onOpen={id => void open(id)} onProject={selectProject} onNewProject={() => setProjectDialog('new')} onEditProject={setProjectDialog} onDeleteProject={id => setDeleting({ kind: 'project', id })} onTask={taskAction} /> : <div className="flex-1" />}
        <div className={cx('p-2.5 flex items-center gap-1 border-t border-[var(--line)]/60', !side && 'flex-col')}>
          <div className="size-7 rounded-full bg-[var(--accent-soft)] grid place-items-center text-accent"><Icon n="user" s={14} /></div>{side && <div className="flex-1 min-w-0 leading-tight ml-1"><div className="text-[12px] font-medium">本机工作空间</div><div className="text-[10.5px] text-[var(--muted)]">v{store.api?.version ?? '—'}</div></div>}
          <IconBtn n={dark ? 'sun' : 'moon'} label="切换主题" onClick={() => setDark(!dark)} /><IconBtn n="gear" label="设置 (Ctrl+,)" onClick={() => setSettings(true)} />
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col rounded-tl-2xl border-t border-l border-[var(--line)] bg-[var(--surface-solid)] overflow-hidden">
        {state.error && <div data-testid="connection-error" role="alert" className="p-3 bg-rose-500/10 text-rose-600 flex items-center gap-3 shrink-0"><Icon n="alert" s={16} /><span className="flex-1 break-words">{state.error}</span>{store.api && <Btn v="outline" onClick={() => void store.initialize()}>重新连接</Btn>}</div>}
        {state.projectNotice && <div data-testid="project-storage-notice" role="status" className="shrink-0 px-4 py-2 border-b border-amber-500/20 bg-amber-500/5 text-[12px] text-amber-800 dark:text-amber-300">{state.projectNotice}</div>}
        {page === 'remote' ? <Remote session={session} onPreview={id=>{setBrowserRequests(before=>({...before,[id]:{sequence:(before[id]?.sequence??0)+1}}));setPanelLayouts(before=>({...before,[id]:{...(before[id]??emptyInspector(defaultPanelWidth.current)),open:true}}));void open(id)}} onOpen={id => void open(id)} onError={flash} onReference={(threadId,ref)=>{setReferenceDrafts(before=>({...before,[threadId]:[...(before[threadId]??[]),ref].slice(0,10)}));void open(threadId)}} /> : page === 'collaborations' ? <Collaborations session={session} models={models} model={currentModel} onOpen={id => void open(id)} onError={flash} /> : page === 'autonomy' ? <Autonomy cwd={session?.meta.cwd ?? workspace} projectId={activeProject?.id} model={currentModel} models={models} session={session} onOpen={id => void open(id)} onError={flash} onReference={ref => { setReferenceDrafts(before => ({ ...before, [draftKey]: [...(before[draftKey] ?? []).filter(value => value.path !== ref.path), ref].slice(0, 10) })); setPage('tasks') }} onTemplate={(value, show = true) => { setDrafts(before => ({ ...before, [value.threadId]: value.text })); setReferenceDrafts(before => ({ ...before, [value.threadId]: value.references })); if (show) void open(value.threadId) }} /> : page === 'integrations' ? <Integrations cwd={session?.meta.cwd ?? workspace} onError={flash} /> : page === 'skills' ? <Skills onError={flash} /> : page === 'overview' ? <Overview onOpen={id => void open(id)} onError={flash} /> : page === 'activity' ? <TaskCenter processes={Object.values(state.processes)} sessions={Object.values(state.sessions)} notifications={notifications} setNotifications={setNotifications} onOpen={id => void open(id, true)} onError={flash} /> : page === 'archives' ? <div data-testid="archives" className="overflow-auto p-8 lg:p-12"><h1 className="text-[24px] font-semibold">归档对话</h1><p className="text-[var(--muted)] mt-2">归档保留内容，可以随时恢复。</p><div className="max-w-3xl mt-8 space-y-3">{Object.values(state.sessions).filter(s => s.meta.archived).map(s => <div key={s.meta.id} data-testid="archived-row" className="flex items-center gap-3 p-4 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]"><Icon n="archive" s={18} className="text-[var(--muted)]" /><button onClick={() => void open(s.meta.id)} className="min-w-0 flex-1 text-left"><span className="block font-medium truncate">{s.meta.title}</span><span className="text-[11px] text-[var(--muted)]" title={workLocation(s.meta).detail}>{workLocation(s.meta).label}</span></button><Btn v="outline" onClick={() => void store.restore(s.meta.id).catch(e => flash(errorText(e)))}>恢复对话</Btn><IconBtn n="trash" label={'删除对话 ' + s.meta.title} onClick={() => setDeleting({ kind: 'thread', id: s.meta.id })} /></div>)}{!Object.values(state.sessions).some(s => s.meta.archived) && <div className="py-12 text-[var(--muted)]">暂无归档对话。</div>}</div></div>
          : session ? <WorkspaceSplit layout={panelLayout} onChange={changePanel} conversation={<TaskView onSsh={()=>{selectSshEntry();setPage('remote')}} onRemote={() => setPage('remote')} onCollaborations={() => setPage('collaborations')} onManage={() => setPage('autonomy')} onOpenBrowser={tabId => { const id = session.meta.id; setBrowserRequests(before => ({ ...before, [id]: { sequence: (before[id]?.sequence ?? 0) + 1, ...(tabId ? { target: tabId } : {}) } })); if (!tabId) { setResources(v=>({...v,[id]:false})); setPanel(true) } }} onOpenProcesses={() => { setResources(v=>({...v,[session.meta.id]:false})); setProcessRequests(before => ({ ...before, [session.meta.id]: (before[session.meta.id] ?? 0) + 1 })); setPanel(true) }} onInspectIssue={id => { setResources(v=>({...v,[session.meta.id]:false})); setErrorRequests(previous => ({ ...previous, [session.meta.id]: { id, sequence: (previous[session.meta.id]?.sequence ?? 0) + 1 } })); setPanel(true) }} planPinned={panelLayout.planPinned} onPinPlan={pinPlan} references={referenceDrafts[draftKey] ?? []} onReferencesChange={setReferences} key={session.meta.id + ':' + attention} session={session} scrollPositions={scrollPositions.current} onOpenFile={file => { setResources(v=>({...v,[session.meta.id]:false})); setSel(file); setPanel(true) }} model={currentModel} setModel={model => void changeModel(model)} models={models} mode={currentMode} setMode={mode => void changeMode(mode)} draft={drafts[draftKey] ?? ''} setDraft={setDraft} onSend={send} onError={flash} onSettings={() => setSettings(true)} />} inspector={focused => resources[session.meta.id] ? <FileContextPanel key={'resources:'+session.meta.id} scope={session.meta.id} remote={!!session.meta.sshTarget||!!session.meta.containerTarget||!!session.meta.collaboration} collaboration={!!session.meta.collaboration} onRemote={()=>setPage(session.meta.collaboration?'collaborations':'remote')} onReference={reference} onClose={()=>{setResources(v=>({...v,[session.meta.id]:false}));setPanel(false)}}/> : <Panel onOpenThread={id => { setProcessRequests(before => ({ ...before, [id]: (before[id] ?? 0) + 1 })); setPanelLayouts(before => ({ ...before, [id]: { ...(before[id] ?? emptyInspector(defaultPanelWidth.current)), open: true } })); void open(id) }} browserRequest={browserRequests[session.meta.id]} processRequest={processRequests[session.meta.id]} errorRequest={errorRequests[session.meta.id]} focus={focused} onFocus={() => focused && !panelLayout.focus ? setPanel(false) : changePanel(before => ({ ...before, focus: !focused }))} planPinned={panelLayout.planPinned} planRequest={panelLayout.planRequest} onUnpinPlan={() => changePanel(before => ({ ...before, planPinned: false }))} key={session.meta.id} memory={previewMemory.current} onReference={reference} session={session} files={activeFiles} sel={sel} setSel={setSel} onClose={() => { setPanel(false); setSel(null) }} onError={flash} />} />
          : <WorkspaceSplit layout={{...homeLayout,open:homeLayout.open&&!!resources.home}} onChange={setHomeLayout} inspector={()=> <FileContextPanel key={managedWorkspace+':'+selectedProject+':'+projectResourcesRevision} scope={managedWorkspace} onChange={setFileView} onReference={reference} onClose={()=>{setResources(v=>({...v,home:false}));setHomeLayout(v=>({...v,open:false}))}}/>} conversation={<div data-testid="home" className="flex-1 overflow-y-auto"><div className="max-w-[640px] mx-auto px-8 pt-[11vh] pb-10">
            <div className="anim-rise text-center"><div className="inline-flex"><Logo s={44} /></div><h1 className="mt-5 text-[28px] font-semibold tracking-tight">{activeProject?.name ?? greet()}</h1><p className="mt-1.5 text-[var(--muted)] text-[14px]">{activeProject ? '项目内的对话将共用你的项目说明。' : '今天想把什么工作交给我？'}</p></div>
            <div className="mt-6 flex justify-center gap-1">{SCENES.map(s => <button key={s} onClick={() => setScene(s)} className={cx('h-7 px-3 rounded-full text-[12px] transition', scene === s ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--muted)] hover:bg-[var(--hover)]')}>{s}</button>)}</div>
            <div className="mt-4"><Composer fileScope={managedWorkspace} key={homeDraftKey + ':' + navigation.current} ws={workspace} references={referenceDrafts[homeDraftKey] ?? []} onReferencesChange={refs => setReferenceDrafts(previous => ({ ...previous, [homeDraftKey]: refs }))} big disabled={!state.connected} submitBlocked={!!spaceError} blockedHint={spaceError ? "本地存储暂不可用，可在下方重试" : undefined} value={drafts[homeDraftKey] ?? ''} setValue={value => setDrafts(d => ({ ...d, [homeDraftKey]: value }))} onSend={send} mode={homeMode} setMode={mode => void changeMode(mode)} model={homeModel} setModel={model => void changeModel(model)} models={models} onError={flash} />
              {spaceError && <div role="alert" data-testid="local-storage-error" className="mt-2 rounded-lg bg-rose-500/5 px-3 py-2 text-[12px] text-rose-600"><p className="break-words">{spaceError}</p><Btn onClick={retryLocalSpace}>重试本地存储</Btn></div>}
              <div className="mt-2 flex flex-wrap items-center gap-2 px-1"><NewChatContext projects={state.projects} project={draftProject} disabled={!state.connected} onProject={id => id ? selectProject(id) : clearProject()} onEditProject={() => draftProject && setProjectDialog(draftProject.id)} /><button type="button" className="text-[12px] text-[var(--muted)] hover:text-accent" onClick={showResources}>资料与产物</button><span data-testid="context-location" className="text-[11px] text-[var(--muted)]">{linkedWorkspace?'执行于 '+folderName(linkedWorkspace):'本地自动保存'}</span>{fileView?.projectDefault&&!fileView.primary&&<Btn onClick={()=>void store.api!.fileContext!<FileContextView>('primary',{scope:managedWorkspace,rootId:fileView.projectDefault}).then(setFileView).catch(e=>flash(errorText(e)))}>使用项目默认目录</Btn>}</div>

            </div>
            <div className="mt-8 grid grid-cols-2 gap-2.5">{EXAMPLES.filter(e => scene === '全部' || e[2] === scene).slice(0, 4).map(([icon, text, category]) => <button key={text} onClick={() => setDrafts(d => ({ ...d, [homeDraftKey]: text }))} className="group p-3.5 rounded-xl border border-[var(--line)] bg-[var(--surface-solid)]/70 text-left hover:bg-[var(--surface-solid)] hover:border-accent/30 hover:-translate-y-0.5 hover:shadow-md transition"><div className="flex items-center justify-between"><span className="size-7 rounded-lg bg-[var(--accent-soft)] text-accent grid place-items-center"><Icon n={icon} s={15} /></span><span className="text-[11px] text-[var(--muted)]">{category}</span></div><div className="mt-2.5 leading-snug">{text}</div></button>)}</div>
            <p className="mt-9 text-center text-[11px] text-[var(--muted)]/80">内容由 AI 生成，请核实重要信息</p>
          </div></div>} />}
      </main>
    </div>
    <footer className="relative z-10 h-[24px] shrink-0 flex items-center gap-4 px-3 text-[11px] text-[var(--muted)] border-t border-[var(--line)] bg-[var(--surface-solid)]/70"><span className="flex items-center gap-1.5"><span className={cx('size-1.5 rounded-full', state.connected ? 'bg-emerald-500' : state.loading ? 'bg-amber-500' : 'bg-rose-500')} />{state.connected ? '内核已连接' : state.loading ? '连接中…' : '内核未连接'}</span><span className="flex items-center gap-1 min-w-0"><Icon n="cpu" s={11} /><span className="truncate max-w-52">{currentModel.split('/').slice(1).join('/') || '—'}</span></span>{session?.usage && <span data-testid="context-usage" title={`当前估算 ${session.usage.inputTokens.toLocaleString()} / ${session.usage.contextWindow.toLocaleString()} Token；约 ${(session.usage.thresholdTokens ?? session.usage.contextWindow * .8).toLocaleString()} Token 时整理。包含已知系统与工具开销；服务商实际计数可能不同。`}>上下文 {Math.round(session.usage.contextUsage * 100)}% · {session.usage.contextWindow.toLocaleString()} Token</span>}<span className="flex-1" />{tasks.some(t => t.status === 'running') && <span className="text-accent">{tasks.filter(t => t.status === 'running').length} 个任务运行中</span>}{pending > 0 && <span className="text-amber-600 dark:text-amber-400">{pending} 项待处理</span>}</footer>
    {toast && <div role="status" className="fixed top-14 left-1/2 -translate-x-1/2 z-[95] max-w-[80vw] px-4 py-2 flex items-center gap-2 rounded-xl bg-[var(--text)] text-[var(--bg)] shadow-xl text-[12px]"><Icon n="info" s={14} /><span className="break-words">{toast}</span><button aria-label="关闭提示" onClick={() => setToast(undefined)}><Icon n="x" s={12} /></button></div>}
    {palette && <Palette tasks={tasks} onClose={() => setPalette(false)} onPick={id => void open(id)} actions={[{ label: '新建任务', icon: 'plus', k: 'Ctrl N', run: newTask }, { label: '打开任务中心', icon: 'list', k: '', run: () => setPage('activity') }, { label: '打开设置', icon: 'gear', k: 'Ctrl ,', run: () => setSettings(true) }, { label: '切换深色模式', icon: 'moon', k: '', run: () => setDark(d => !d) }, { label: '打开资料与产物', icon: 'folder', k: '', run: () => void pickFolder() }]} />}
    {onboarding && state.connected && <Onboarding onDone={doneOnboarding} onSettings={() => setSettings(true)} onPickFolder={pickFolder} workspace={linkedWorkspace} configured={!!state.settings?.providers[state.settings.effective.defaultProvider]?.hasKey} />}
    {settings && state.settings && <Settings settings={state.settings} onClose={() => setSettings(false)} dark={dark} setDark={setDark} />}
    {projectDialog && <ProjectDialog project={state.projects.find(p => p.id === projectDialog)} onClose={() => setProjectDialog(undefined)} onSaved={p => { setProjectDialog(undefined); setProjectResourcesRevision(n=>n+1); beginProject(p) }} onError={flash} />}
    {deleting && <Modal onClose={() => setDeleting(undefined)} label={deleting.kind === 'thread' ? '删除对话' : '删除项目'} w="w-[420px]"><div className="p-6"><h2 className="text-[18px] font-semibold">{deleting.kind === 'thread' ? '删除这段对话？' : '删除这个项目？'}</h2><p className="text-[var(--muted)] mt-3 leading-relaxed">{deleting.kind === 'thread' ? '对话历史将永久删除，工作文件夹中的实际文件会保留。' : '项目说明和分组将删除，对话会移回普通列表，内容保留。'}</p><div className="flex justify-end gap-2 mt-6"><Btn onClick={() => setDeleting(undefined)}>取消</Btn><Btn v="danger" onClick={() => void confirmDelete()}>确认删除</Btn></div></div></Modal>}
    {rename && <Modal onClose={() => setRename(undefined)} label="重命名任务" w="w-[420px]"><form className="p-6" onSubmit={event => { event.preventDefault(); void store.updateThread(rename, { title: name }, 'thread/rename').then(() => setRename(undefined)).catch(err => flash(errorText(err))) }}><h2 className="text-[17px] font-semibold mb-4">重命名任务</h2><input autoFocus aria-label="任务名称" maxLength={120} value={name} onChange={e => setName(e.target.value)} className="field w-full" /><div className="flex justify-end gap-2 mt-5"><Btn type="button" onClick={() => setRename(undefined)}>取消</Btn><Btn type="submit" v="primary" disabled={!name.trim()}>保存</Btn></div></form></Modal>}
  </div>
}
