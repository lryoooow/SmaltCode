import type { ApprovalDecision, ApprovalRequest, Item, ThreadMeta, ProjectMeta, ThreadStatus, ThreadTokenUsage, UserInputRequest } from '../../../../kernel/src/protocol/types'

export type { ApprovalDecision, ApprovalRequest, Item, ThreadMeta, ProjectMeta, ThreadStatus, ThreadTokenUsage, UserInputRequest }
export type SettingsData = {
  providers: Record<string, { baseUrl: string; wire: string; apiKeyEnv?: string; hasKey: boolean; defaultModel?: string }>
  effective: { defaultProvider: string; defaultModel: string; permissionMode: string }
  keyStorage: 'encrypted' | 'session'
}
export type FilePreview = { binary: boolean; size: number; text: string; reason?: string; digest?: string }
export type ContextReference = { path: string; start?: number; end?: number; digest?: string; label?: string }
export type Checkpoint = import('../../../../kernel/src/storage/checkpoints').CheckpointSummary
export interface DesktopAPI {
  version: string
  platform: string
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  onNotify(cb: (method: string, params: unknown) => void): () => void
  onApproval(cb: (req: ApprovalRequest) => void): () => void
  onInput(cb: (req: UserInputRequest) => void): () => void
  onResolved(cb: (id: string) => void): () => void
  respondApproval(id: string, decision: ApprovalDecision): Promise<void>
  respondInput(id: string, text: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<{ canceled: true; reason?: string } | { canceled: false; dir: string }>
  pickFiles(): Promise<string[]>
  searchFiles(cwd: string, query: string): Promise<{ files: string[]; truncated: boolean }>
  resolveContext(cwd: string, refs: ContextReference[]): Promise<{ text: string; references: Array<{ path: string; label: string }> }>
  activity(threadId: string | null, enabled: boolean): Promise<void>
  onNavigate(cb: (threadId: string) => void): () => void
  loadSettings(): Promise<SettingsData>
  saveSettings(patch: Record<string, unknown>): Promise<{ ok: boolean }>
  testProvider(provider: string, model: string): Promise<{ ok: boolean }>
  file(threadId: string, path: string, action: 'read' | 'reveal'): Promise<FilePreview>
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>
}
declare global { interface Window { smalt?: DesktopAPI } }

export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
export const folderName = (dir: string) => dir.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || dir

export type TurnSummary = { turnId: string; durationMs: number; toolCount: number; fileCount: number; usage: { inputTokens: number; outputTokens: number } }
export type Session = {
  meta: ThreadMeta; items: Item[]; status?: ThreadStatus; usage?: ThreadTokenUsage; error?: string
  summaries: TurnSummary[]; interrupted?: boolean; unread?: boolean; sending?: boolean
  approvals: Record<string, ApprovalRequest>; questions: Record<string, UserInputRequest>
}
export type Snapshot = { connected: boolean; loading: boolean; error?: string; sessions: Record<string, Session>; projects: ProjectMeta[]; settings?: SettingsData }
function readSeen(): Record<string, number> { try { const data = JSON.parse(localStorage.getItem('smalt.ui.seen') ?? '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) : {} } catch { return {} } }

/** One subscription owns all sessions. Changing the visible task never interrupts it. */
export class DesktopStore {
  private state: Snapshot = { connected: false, loading: true, sessions: {}, projects: [] }
  private listeners = new Set<() => void>()
  private boot?: Promise<void>
  private unsubscribe: Array<() => void> = []
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
    this.commit({ sessions: { ...this.state.sessions, [meta.id]: previous ? { ...previous, meta } : {
      meta, items: [], summaries: [], approvals: {}, questions: {},
      interrupted: meta.lastOutcome === 'interrupted', error: meta.lastOutcome === 'failed' ? '上次执行失败，请查看对话或继续任务。' : undefined,
      unread: meta.turnCount > 0 && Date.parse(meta.updatedAt) > (this.seen[meta.id] ?? 0),
    } } })
  }
  private item(item: Item) {
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
        const [result, settings, projects] = await Promise.all([this.api!.call<{ threads: ThreadMeta[] }>('thread/list', { includeArchived: true }), this.api!.loadSettings(), this.api!.call<{ projects: ProjectMeta[] }>('project/list')])
        result.threads.forEach(meta => this.upsert(meta))
        this.commit({ connected: true, loading: false, settings, projects: projects.projects ?? [], error: undefined })
      } catch (err) { this.commit({ connected: false, loading: false, error: errorText(err) }); this.boot = undefined }
    })()
    return this.boot
  }
  private notify(method: string, value: unknown) {
    const p = value as { threadId?: string; meta?: ThreadMeta; item?: Item; itemId?: string; turnId?: string; delta?: string; error?: string; usage?: ThreadTokenUsage; summary?: Omit<TurnSummary, 'turnId'>; interrupted?: boolean } & Partial<ThreadStatus>
    if (p.meta) this.upsert(p.meta)
    if ((method === 'item/started' || method === 'item/completed') && p.item) this.item(p.item)
    if (!p.threadId) return
    const id = p.threadId
    if ((method === 'turn/completed' || method === 'turn/failed') && id === this.current) this.rememberRead(id)
    if (method === 'thread/deleted') { const sessions = { ...this.state.sessions }; delete sessions[id]; this.commit({ sessions }); return }
    if (method === 'thread/archived') this.update(id, s => ({ ...s, meta: { ...s.meta, archived: true } }))
    if (method === 'thread/status/changed') this.update(id, s => ({ ...s, status: p as ThreadStatus }))
    if (method.endsWith('/delta') || method.endsWith('/textDelta') || method.endsWith('/outputDelta')) {
      this.update(id, s => ({ ...s, items: s.items.map(item => {
        if (item.id !== p.itemId) return item
        if (item.kind === 'agentMessage' || item.kind === 'reasoning') return { ...item, text: item.text + (p.delta ?? '') }
        if (item.kind === 'commandExecution') return { ...item, output: (item.output + (p.delta ?? '')).slice(-30000) }
        return item
      }) }))
    }
    if (method === 'thread/tokenUsage/updated') this.update(id, s => ({ ...s, usage: p.usage }))
    if (method === 'turn/started') this.update(id, s => ({ ...s, error: undefined, interrupted: false, unread: false, sending: false }))
    if (method === 'turn/failed' || method === 'turn/completed') this.update(id, s => ({
      ...s, error: p.error, interrupted: p.interrupted, sending: false,
      unread: id !== this.current, approvals: {}, questions: {},
      items: s.items.filter(i => !(i.kind === 'commandExecution' && i.tool === 'plan' && i.status === 'inProgress')).map(i => i.status === 'inProgress' ? { ...i, status: p.interrupted || p.error ? 'failed' : 'completed' } : i),
      summaries: p.summary ? [...s.summaries, { ...p.summary, turnId: p.turnId! }] : s.summaries,
    }))
  }
  async open(id: string) {
    this.current = id
    const result = await this.api!.call<{ meta: ThreadMeta; items: Item[]; status: ThreadStatus }>('thread/read', { threadId: id })
    this.upsert(result.meta)
    this.update(id, s => {
      const items = new Map(result.items.map(i => [i.id, i]))
      s.items.forEach(i => items.set(i.id, i))
      if (this.current === id) this.rememberRead(id)
      return { ...s, items: [...items.values()], status: s.status ?? result.status, unread: this.current === id ? false : s.unread }
    })
  }
  select(id: string | null) { this.current = id }
  markAllRead() {
    const at = Date.now(); Object.keys(this.state.sessions).forEach(id => { this.seen[id] = at }); this.saveSeen()
    this.commit({ sessions: Object.fromEntries(Object.entries(this.state.sessions).map(([id, s]) => [id, { ...s, unread: false }])) })
  }
  busy(id: string) { const s = this.state.sessions[id]; return !!s && (!!s.sending || (!!s.status && s.status.lifecycle !== 'idle')) }
  async send(id: string | null, text: string, cwd: string, model: string, permissionMode: string, projectId?: string, context?: { text: string; references: Array<{ path: string; label: string }> }): Promise<string> {
    if (!this.api || !this.state.connected) throw new Error('内核未连接')
    let threadId = id
    if (!threadId) {
      if (!cwd) throw new Error('请先选择工作文件夹')
      const result = await this.api.call<{ meta: ThreadMeta; threadId: string }>('thread/start', { cwd, model, permissionMode, projectId, title: text.slice(0, 60) })
      this.upsert(result.meta); threadId = result.threadId
    }
    const input = text + (context?.text ?? ''), displayText = text, references = context?.references
    if (this.busy(threadId)) {
      await this.api.call('turn/steer', { threadId, message: input, displayText, references })
      this.update(threadId, s => ({ ...s, status: s.status ? { ...s.status, queuedMessages: s.status.queuedMessages + 1 } : s.status }))
    } else {
      this.update(threadId, s => ({ ...s, sending: true, error: undefined }))
      void this.api.call('turn/start', { threadId, input, displayText, references }).catch(err => this.update(threadId!, s => ({ ...s, sending: false, error: errorText(err) })))
    }
    return threadId
  }
  async updateSettings(patch: Record<string, unknown>) {
    await this.api!.saveSettings(patch)
    this.commit({ settings: await this.api!.loadSettings() })
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
    this.commit({ projects: [...this.state.projects.filter(p => p.id !== result.project.id), result.project] })
    return result.project
  }
  async deleteProject(id: string) {
    await this.api!.call('project/delete', { projectId: id })
    this.commit({ projects: this.state.projects.filter(p => p.id !== id), sessions: Object.fromEntries(Object.entries(this.state.sessions).map(([key, s]) => [key, s.meta.projectId === id ? { ...s, meta: { ...s.meta, projectId: undefined } } : s])) })
  }
  dispose() { this.unsubscribe.forEach(off => off()); this.unsubscribe = []; this.boot = undefined }
}
export const store = new DesktopStore(typeof window === 'undefined' ? undefined : window.smalt)
