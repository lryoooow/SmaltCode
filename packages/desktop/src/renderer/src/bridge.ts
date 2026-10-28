import type { ApprovalDecision, ApprovalRequest, Item, ThreadMeta, ProjectMeta, ThreadStatus, ThreadTokenUsage, UserInputRequest, ContextNotice } from '../../../../kernel/src/protocol/types'
import { itemAssessment } from '../../../../kernel/src/protocol/assessment'

function annotateResult(item: Item): Item {
  if (item.kind !== 'commandExecution' || item.assessment || item.status === 'inProgress') return item
  const assessment = itemAssessment(item)
  return assessment ? { ...item, assessment } : item
}

export type { ApprovalDecision, ApprovalRequest, Item, ThreadMeta, ProjectMeta, ThreadStatus, ThreadTokenUsage, UserInputRequest }
export type SettingsData = {
  catalogs?: Record<string, import('../../../../kernel/src/models/catalog').CatalogResult>
  providers: Record<string, { baseUrl: string; wire: 'chat' | 'anthropic'; apiKeyEnv?: string; hasKey: boolean; defaultModel?: string; contextWindow?: number; modelContextWindows?: Record<string, number | null> }>
  compactThreshold?: number
  effective: { defaultProvider: string; defaultModel: string; permissionMode: string }
  keyStorage: 'encrypted' | 'session'
}
export type FilePreview = { binary: boolean; size: number; text: string; reason?: string; digest?: string } & Partial<import('../../shared/documents').DocumentContent> & { dataUrl?: string }
export type Skill = import('../../main/skills').Skill
export type SkillPreview = import('../../main/skills').SkillPreview & { token: string }
export type Attachment = import('../../shared/documents').Attachment
export type DesktopOverview = import('../../shared/overview').DesktopOverview
export type ContextReference = { path: string; start?: number; end?: number; digest?: string; label?: string }
export type Checkpoint = import('../../../../kernel/src/storage/checkpoints').CheckpointSummary
export type { ManagedProcess, ProcessOutput, ProcessEvent } from '../../shared/processes'
import type { ManagedProcess, ProcessOutput, ProcessEvent } from '../../shared/processes'
export interface DesktopAPI {
  fileContext?<T=any>(action:string,value?:unknown):Promise<T>
  localSpace?(action: 'create'): Promise<{ cwd: string; kind: 'managed' }>;
  containers<T=unknown>(action:string,value?:unknown):Promise<T>
  onContainers(cb:()=>void):()=>void
  ssh<T=unknown>(action:string,value?:unknown):Promise<T>
  onSsh(cb:()=>void):()=>void
  artifacts<T=unknown>(action:string,value?:unknown):Promise<T>
  onArtifactSelection?(cb:(value:{threadId:string;text:string})=>void):()=>void
  onArtifactUpdated(cb:(value:{threadId:string;path:string})=>void):()=>void
  remote<T = unknown>(action: string, value?: unknown): Promise<T>
  onRemote(cb: () => void): () => void
  collaborations<T = unknown>(action: string, value?: unknown): Promise<T>
  onCollaborations(cb: () => void): () => void
  autonomy<T = unknown>(action: string, value?: unknown): Promise<T>
  onAutonomy(cb: () => void): () => void
  integrations<T = unknown>(action: string, value?: unknown): Promise<T>
  onIntegrations(cb: () => void): () => void
  browser<T = unknown>(action: string, value?: unknown): Promise<T>
  feedback<T = unknown>(action: string, value?: unknown): Promise<T>
  onBrowser(cb: () => void): () => void
  onBrowserShortcut(cb: (value: { key: string; control: boolean; shift?: boolean }) => void): () => void
  processes<T = unknown>(action: string, value?: unknown): Promise<T>
  onProcess(cb: (event: ProcessEvent) => void): () => void
  version: string
  platform: string
  developmentPreview?: boolean
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  onNotify(cb: (method: string, params: unknown) => void): () => void
  onApproval(cb: (req: ApprovalRequest) => void): () => void
  onInput(cb: (req: UserInputRequest) => void): () => void
  onResolved(cb: (id: string) => void): () => void
  respondApproval(id: string, decision: ApprovalDecision): Promise<void>
  respondInput(id: string, text: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<{ canceled: true; reason?: string } | { canceled: false; dir: string }>
  skills<T = unknown>(action: string, value?: unknown): Promise<T>
  pickAttachments(): Promise<{ attachments: Attachment[]; errors: string[] }>
  pasteImage(base64: string, mime: string): Promise<Attachment>
  attachment(id: string): Promise<FilePreview>
  overview(): Promise<DesktopOverview>
  exportDiagnostics(): Promise<{ canceled: boolean }>
  searchFiles(cwd: string, query: string): Promise<{ files: string[]; truncated: boolean }>
  previewFile(cwd: string, path: string,fileScope?:string): Promise<FilePreview>
  inspectContext(cwd: string, refs: ContextReference[],fileScope?:string): Promise<import('../../shared/context').ContextCheck>
  resolveContext(cwd: string, refs: ContextReference[],threadId?:string,fileScope?:string): Promise<{ text: string; references: Array<{ path: string; label: string }>; images?: import('../../../../kernel/src/models/types').ImagePart[] }>
  activity(threadId: string | null, enabled: boolean): Promise<void>
  onNavigate(cb: (threadId: string) => void): () => void
  loadSettings(): Promise<SettingsData>
  saveSettings(patch: Record<string, unknown>): Promise<{ ok: boolean }>
  testProvider(provider: string, model: string): Promise<{ ok: boolean }>
  listModels?(provider: string, force?: boolean, model?: string): Promise<import('../../../../kernel/src/models/catalog').CatalogResult>
  file(threadId: string, path: string, action: 'read' | 'reveal'): Promise<FilePreview>
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>
}
declare global { interface Window { smalt?: DesktopAPI } }

export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
export const folderName = (dir: string) => dir.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || dir

export type SteeringEntry = import('../../../../kernel/src/protocol/types').SteeringEntry
export type TurnSummary = import('../../../../kernel/src/protocol/types').TurnSummary
export type Session = {
  meta: ThreadMeta; items: Item[]; status?: ThreadStatus; usage?: ThreadTokenUsage; error?: string
  contextNotice?: ContextNotice
  steering?: SteeringEntry[]
  summaries: TurnSummary[]; runningSince?: number; interrupted?: boolean; unread?: boolean; sending?: boolean
  approvals: Record<string, ApprovalRequest>; questions: Record<string, UserInputRequest>
}
export type Snapshot = { artifactRevisions?:Record<string,number>; processes: Record<string, ManagedProcess>; processOutput: Record<string, ProcessOutput>; processNotice?: string; connected: boolean; loading: boolean; error?: string; projectNotice?: string; sessions: Record<string, Session>; projects: ProjectMeta[]; settings?: SettingsData }
function readSeen(): Record<string, number> { try { const data = JSON.parse(localStorage.getItem('smalt.ui.seen') ?? '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) : {} } catch { return {} } }

/** One subscription owns all sessions. Changing the visible task never interrupts it. */
export class DesktopStore {
  private state: Snapshot = { processes: {}, processOutput: {}, connected: false, loading: true, sessions: {}, projects: [] }
  private listeners = new Set<() => void>()
  private boot?: Promise<void>
  private unsubscribe: Array<() => void> = []
  private epoch = 0
  private settingsEpoch = 0
  private catalogRequests = new Map<string, Promise<import('../../../../kernel/src/models/catalog').CatalogResult | undefined>>()
  private deltaTimer?: ReturnType<typeof setTimeout>
  private deltas = new Map<string, Map<string, string>>()
  private current: string | null = null
  private seen = readSeen()
  private rememberRead(id: string) {
    this.seen[id] = Date.now()
    this.saveSeen()
  }
  private saveSeen() {
    try { localStorage.setItem('smalt.ui.seen', JSON.stringify(Object.fromEntries(Object.entries(this.seen).sort((a, b) => b[1] - a[1]).slice(0, 1000)))) } catch { /* unavailable storage */ }
  }
  constructor(readonly api: DesktopAPI | undefined) {}
  artifactRevision(cwd:string,path:string){let p=path.replace(/\\/g,'/'),root=cwd.replace(/\\/g,'/').replace(/\/$/,'');if(p.toLowerCase().startsWith(root.toLowerCase()+'/'))p=p.slice(root.length+1);return this.state.artifactRevisions?.[root.toLowerCase()+':'+p.toLowerCase()]??0}
  private artifactUpdated(value:{threadId:string;path:string}){const meta=this.state.sessions[value.threadId]?.meta;if(!meta)return;const root=meta.cwd.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase(),key=root+':'+value.path.replace(/\\/g,'/').toLowerCase(),old=this.state.artifactRevisions??{},rows=Object.entries(old).filter(([k])=>k!==key).slice(-499);this.commit({artifactRevisions:{...Object.fromEntries(rows),[key]:(old[key]??0)+1}})}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private commit(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l()) }
  private update(id: string, fn: (s: Session) => Session) {
    const session = this.state.sessions[id]
    if (session) this.commit({ sessions: { ...this.state.sessions, [id]: fn(session) } })
  }
  private upsert(meta: ThreadMeta) {
    const previous = this.state.sessions[meta.id]
    if (this.current === meta.id) this.rememberRead(meta.id)
    this.commit({ sessions: { ...this.state.sessions, [meta.id]: this.sessionFromMeta(meta, previous) } })
  }
  private sessionFromMeta(meta: ThreadMeta, previous?: Session): Session {
    return previous ? { ...previous, meta } : {
      meta, items: [], summaries: [], approvals: {}, questions: {},
      interrupted: meta.lastOutcome === 'interrupted', error: meta.lastOutcome === 'failed' ? meta.lastError ?? '上次执行失败，请查看下方具体操作记录。旧版未保存任务终止原因。' : undefined,
      unread: meta.turnCount > 0 && Date.parse(meta.updatedAt) > (this.seen[meta.id] ?? 0),
    }
  }
  private item(item: Item) {
    item = annotateResult(item)
    this.update(item.threadId, s => {
      const index = s.items.findIndex(i => i.id === item.id)
      const items = [...s.items]
      if (index < 0) items.push(item); else items[index] = item
      return { ...s, items }
    })
  }
  initialize() {
    if (this.boot) return this.boot
    if (!this.api) { this.commit({ loading: false, error: '桌面内核未连接。请使用 SmaltCode 桌面程序打开这个界面。' }); return Promise.resolve() }
    const epoch = ++this.epoch
    this.unsubscribe.splice(0).forEach(off => off())
    this.unsubscribe = [
      this.api.onNotify((m, p) => this.notify(m, p)),
      this.api.onApproval(req => this.update(req.threadId, s => ({ ...s, approvals: { ...s.approvals, [req.itemId]: req } }))),
      this.api.onInput(req => this.update(req.threadId, s => ({ ...s, questions: { ...s.questions, [req.itemId]: req } }))),
      this.api.onResolved(id => {
        for (const [threadId, s] of Object.entries(this.state.sessions)) {
          if (s.approvals[id] || s.questions[id]) this.update(threadId, s => {
            const approvals = { ...s.approvals }; const questions = { ...s.questions }
            delete approvals[id]; delete questions[id]; return { ...s, approvals, questions }
          })
        }
      }),
    ]
    this.boot = (async () => {
      try {
        await this.api!.call('initialize')
        const [result, settings, projects] = await Promise.all([this.api!.call<{ threads: ThreadMeta[] }>('thread/list', { includeArchived: true }), this.api!.loadSettings(), this.api!.call<{ projects: ProjectMeta[]; notice?: string }>('project/list')])
        if (epoch !== this.epoch) return
        const sessions = { ...this.state.sessions }
        for (const meta of result.threads) sessions[meta.id] = this.sessionFromMeta(meta, sessions[meta.id])
        this.commit({ sessions, connected: true, loading: false, settings, projects: projects.projects ?? [], projectNotice: projects.notice, error: undefined })
        const offArtifacts=this.api!.onArtifactUpdated?.(value=>this.artifactUpdated(value));if(offArtifacts)this.unsubscribe.push(offArtifacts);
        const offProcess = this.api!.onProcess?.(event => this.processEvent(event)); if (offProcess) this.unsubscribe.push(offProcess)
        await this.refreshProcesses()
        this.refreshConfiguredModels()
      } catch (err) { if (epoch === this.epoch) { this.unsubscribe.splice(0).forEach(off => off()); this.commit({ connected: false, loading: false, error: errorText(err) }); this.boot = undefined } }
    })()
    return this.boot
  }
  private processEvent(event: ProcessEvent) {
    const before = this.state.processes[event.process.id]
    const processes = before && before.revision > event.process.revision ? this.state.processes : { ...this.state.processes, [event.process.id]: event.process }
    let processOutput = this.state.processOutput
    if (event.output) {
      const old = processOutput[event.process.id], output = event.output
      if (!old || output.end > old.end) {
        const data = (old && old.end === output.from ? old.data + output.data : output.data).slice(-65536)
        processOutput = { ...processOutput, [event.process.id]: { data, end: output.end, from: output.end - data.length } }
      }
    }
    const ids = Object.keys(processes)
    if (ids.length > 80) {
      const old = ids.filter(id => !['starting', 'running', 'stopping'].includes(processes[id].state)).sort((a, b) => processes[a].startedAt.localeCompare(processes[b].startedAt)).slice(0, ids.length - 80)
      const bounded = { ...processes }; processOutput = { ...processOutput }
      for (const id of old) { delete bounded[id]; delete processOutput[id] }
      this.commit({ processes: bounded, processOutput }); return
    }
    this.commit({ processes, processOutput })
  }
  async refreshProcesses() {
    if (!this.api?.processes) return
    const result = await this.api.processes<{ processes: ManagedProcess[]; notice?: string }>('list')
    for (const process of result.processes) this.processEvent({ process })
    this.commit({ processNotice: result.notice })
  }
  async readProcess(threadId: string, id: string) {
    const result = await this.api!.processes<ProcessEvent>('read', { threadId, id }); this.processEvent(result)
  }
  private notify(method: string, value: unknown) {
    const delta = method.endsWith('/delta') || method.endsWith('/textDelta') || method.endsWith('/outputDelta')
    if (!delta) this.flushDeltas()
    const p = value as { threadId?: string; meta?: ThreadMeta; item?: Item; itemId?: string; turnId?: string; delta?: string; error?: string; usage?: ThreadTokenUsage; summary?: Omit<TurnSummary, 'turnId'>; interrupted?: boolean; notice?: ContextNotice } & { entry?: SteeringEntry } & Partial<ThreadStatus>
    if (p.meta) this.upsert(p.meta)
    if ((method === 'item/started' || method === 'item/completed') && p.item) this.item(p.item)
    if (!p.threadId) return
    const id = p.threadId
    if ((method === 'turn/completed' || method === 'turn/failed') && id === this.current) this.rememberRead(id)
    if (method === 'thread/deleted') { const sessions = { ...this.state.sessions }, processes = { ...this.state.processes }, processOutput = { ...this.state.processOutput }; delete sessions[id]; for (const [key, value] of Object.entries(processes)) if (value.threadId === id) { delete processes[key]; delete processOutput[key] }; this.commit({ sessions, processes, processOutput }); return }
    if (method === 'thread/archived') this.update(id, s => ({ ...s, meta: { ...s.meta, archived: true } }))
    if (method === 'thread/steering/changed' && p.entry) this.updateSteering(id, p.entry)
    if (method === 'thread/status/changed') this.update(id, s => ({ ...s, status: p as ThreadStatus }))
    if (delta && p.itemId) {
      const pending = this.deltas.get(id) ?? new Map<string, string>()
      const value = (pending.get(p.itemId) ?? '') + (p.delta ?? '')
      pending.set(p.itemId, method.endsWith('/outputDelta') ? value.slice(-30000) : value); this.deltas.set(id, pending)
      this.deltaTimer ??= setTimeout(() => this.flushDeltas(), 50)
    }
    if (method === 'thread/tokenUsage/updated') this.update(id, s => ({ ...s, usage: p.usage }))
    if (method === 'thread/context/notice') this.update(id, s => ({ ...s, contextNotice: p.notice }))
    if (method === 'turn/started') this.update(id, s => ({ ...s, runningSince: Date.now(), error: undefined, contextNotice: undefined, interrupted: false, unread: false, sending: false }))
    if (method === 'turn/failed' || method === 'turn/completed') this.update(id, s => ({
      ...s, runningSince: undefined, error: p.error, interrupted: p.interrupted, sending: false,
      unread: id !== this.current, approvals: {}, questions: {},
      items: s.items.filter(i => !(i.kind === 'commandExecution' && i.tool === 'plan' && i.status === 'inProgress')).map(i => i.status === 'inProgress' ? { ...i, status: p.interrupted || p.error ? 'failed' : 'completed' } : i),
      summaries: p.summary ? [...s.summaries, { ...p.summary, turnId: p.turnId! }] : s.summaries,
    }))
  }
  private flushDeltas() {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = undefined
    if (!this.deltas.size) return
    const pending = this.deltas; this.deltas = new Map()
    const sessions = { ...this.state.sessions }
    for (const [id, parts] of pending) {
      const session = sessions[id]; if (!session) continue
      sessions[id] = { ...session, items: session.items.map(item => {
        const text = parts.get(item.id); if (!text) return item
        if (item.kind === 'agentMessage' || item.kind === 'reasoning') return { ...item, text: item.text + text }
        if (item.kind === 'commandExecution') return { ...item, output: (item.output + text).slice(-30000) }
        return item
      }) }
    }
    this.commit({ sessions })
  }
  async open(id: string) {
    this.current = id
    this.flushDeltas()
    const before = this.state.sessions[id]
    const result = await this.api!.call<{ meta: ThreadMeta; items: Item[]; status: ThreadStatus; usage?: ThreadTokenUsage; summaries?: TurnSummary[]; contextNotice?: ContextNotice; steering?: SteeringEntry[] }>('thread/read', { threadId: id })
    this.flushDeltas()
    this.upsert(result.meta)
    this.update(id, s => {
      const items = new Map(result.items.map(i => [i.id, annotateResult(i)]))
      const initial = new Map(before?.items.map(item => [item.id, item]) ?? [])
      s.items.forEach(i => { if (i !== initial.get(i.id) || i.status === 'inProgress' && result.status?.lifecycle !== 'idle') items.set(i.id, i) })
      if (this.current === id) this.rememberRead(id)
      const liveTurnChanged = s.runningSince !== before?.runningSince || s.status !== before?.status
      const keepLiveError = liveTurnChanged || result.status.lifecycle !== 'idle' || s.error !== before?.error
      return { ...s, items: [...items.values()], steering: this.mergeSteering(result.steering ?? [], s.steering ?? []), status: s.status !== before?.status ? s.status : result.status, usage: s.usage !== before?.usage ? s.usage : result.usage ?? s.usage, summaries: s.summaries !== before?.summaries ? s.summaries : result.summaries ?? s.summaries, contextNotice: liveTurnChanged || s.contextNotice !== before?.contextNotice ? s.contextNotice : result.contextNotice, error: keepLiveError ? s.error : result.meta.lastOutcome === 'failed' ? result.meta.lastError ?? s.error : undefined, unread: this.current === id ? false : s.unread }
    })
  }
  select(id: string | null) { this.current = id }
  markAllRead() {
    const at = Date.now(); Object.keys(this.state.sessions).forEach(id => { this.seen[id] = at }); this.saveSeen()
    this.commit({ sessions: Object.fromEntries(Object.entries(this.state.sessions).map(([id, s]) => [id, { ...s, unread: false }])) })
  }
  busy(id: string) { const s = this.state.sessions[id]; return !!s && (!!s.sending || (!!s.status && s.status.lifecycle !== 'idle')) }
  async send(id: string | null, text: string, cwd: string, model: string, permissionMode: string, projectId?: string, context?: { text: string; references: Array<{ path: string; label: string }>; images?: import('../../../../kernel/src/models/types').ImagePart[]; fileScope?: string }): Promise<string> {
    if (!this.api || !this.state.connected) throw new Error('内核未连接')
    let threadId = id
    if (!threadId) {
      const result = await this.api.call<{ meta: ThreadMeta; threadId: string }>('thread/start', { cwd, model, permissionMode, projectId, title: text.slice(0, 60), ...(context?.fileScope?{fileScope:context.fileScope}:{}) })
      this.upsert(result.meta); threadId = result.threadId
    }
    const input = text + (context?.text ?? ''), displayText = text, references = context?.references
    if (this.busy(threadId)) {
      const result = await this.api.call<{ entry?: SteeringEntry }>('turn/steer', { threadId, message: input, displayText, references, images: context?.images })
      if (result.entry) this.updateSteering(threadId, result.entry)
    } else {
      this.update(threadId, s => ({ ...s, sending: true, error: undefined }))
      void this.api.call('turn/start', { threadId, input, displayText, references, images: context?.images }).catch(err => this.update(threadId!, s => ({ ...s, sending: false, error: errorText(err) })))
    }
    return threadId
  }
  private mergeSteering(first: SteeringEntry[], second: SteeringEntry[]): SteeringEntry[] {
    const entries = new Map(first.map(entry => [entry.id, entry]));
    for (const entry of second) if ((entries.get(entry.id)?.revision ?? 0) <= entry.revision) entries.set(entry.id, entry);
    return [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100)
  }
  private updateSteering(id: string, entry: SteeringEntry) {
    this.update(id, s => ({ ...s, steering: this.mergeSteering(s.steering ?? [], [entry]) }))
  }
  async changeSteering(id: string, entry: SteeringEntry, text?: string) {
    try {
      const result = await this.api!.call<{ entry: SteeringEntry }>(text === undefined ? 'turn/steer/cancel' : 'turn/steer/update', { threadId: id, id: entry.id, revision: entry.revision, text })
      this.updateSteering(id, result.entry)
    } catch (error) {
      const result = await this.api!.call<{ steering?: SteeringEntry[] }>('thread/read', { threadId: id }).catch(() => undefined)
      if (result?.steering) this.update(id, s => ({ ...s, steering: this.mergeSteering(result.steering!, s.steering ?? []) }))
      throw error
    }
  }
  async updateSettings(patch: Record<string, unknown>) {
    ++this.settingsEpoch
    await this.api!.saveSettings(patch)
    this.commit({ settings: await this.api!.loadSettings() })
    this.refreshConfiguredModels()
  }
  private refreshConfiguredModels() {
    for (const [id, provider] of Object.entries(this.state.settings?.providers ?? {})) if (provider.hasKey && (id !== 'ollama' || this.state.settings?.effective.defaultProvider === id)) void this.loadModels(id).catch(() => {})
  }
  loadModels(provider: string, force = false, model?: string): Promise<import('../../../../kernel/src/models/catalog').CatalogResult | undefined> {
    const epoch = this.settingsEpoch, bootEpoch = this.epoch, key = `${epoch}:${provider}:${model ?? ''}`
    const pending = this.catalogRequests.get(key); if (pending) return force ? pending.then(() => this.loadModels(provider, true, model)) : pending
    const task = (async () => {
      if (!this.api?.listModels) return undefined
      const result = await this.api.listModels(provider, force, model)
      if (epoch === this.settingsEpoch && bootEpoch === this.epoch && this.state.settings && (result.revision ?? 0) >= (this.state.settings.catalogs?.[provider]?.revision ?? 0)) this.commit({ settings: { ...this.state.settings, catalogs: { ...this.state.settings.catalogs, [provider]: result } } })
      return epoch === this.settingsEpoch && bootEpoch === this.epoch ? result : undefined
    })().finally(() => this.catalogRequests.delete(key))
    this.catalogRequests.set(key, task); return task
  }
  async updateThread(id: string, patch: Record<string, unknown>, method = 'thread/settings/update') {
    const result = await this.api!.call<{ meta: ThreadMeta }>(method, { threadId: id, ...patch })
    this.upsert(result.meta)
  }
  async archive(id: string) {
    await this.api!.call('thread/archive', { threadId: id })
    this.update(id, s => ({ ...s, meta: { ...s.meta, archived: true } }))
  }
  async restore(id: string) { await this.updateThread(id, {}, 'thread/restore') }
  async delete(id: string) {
    await this.api!.call('thread/delete', { threadId: id })
    const sessions = { ...this.state.sessions }; delete sessions[id]; this.commit({ sessions })
  }
  async saveProject(id: string | undefined, patch: { name: string; instructions: string; cwd?: string | null }) {
    const result = await this.api!.call<{ project: ProjectMeta }>(id ? 'project/update' : 'project/create', { projectId: id, ...patch })
    this.commit({ projectNotice: undefined, projects: [...this.state.projects.filter(p => p.id !== result.project.id), result.project] })
    return result.project
  }
  async deleteProject(id: string) {
    await this.api!.call('project/delete', { projectId: id })
    this.commit({ projectNotice: undefined, projects: this.state.projects.filter(p => p.id !== id), sessions: Object.fromEntries(Object.entries(this.state.sessions).map(([key, s]) => [key, s.meta.projectId === id ? { ...s, meta: { ...s.meta, projectId: undefined } } : s])) })
  }
  dispose() { this.flushDeltas(); this.epoch++; this.unsubscribe.splice(0).forEach(off => off()); this.boot = undefined }
}
export const store = new DesktopStore(typeof window === 'undefined' ? undefined : window.smalt)
