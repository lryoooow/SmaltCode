import type { FileItem } from './Task'
import type { FilePreview } from '../bridge'
export type PreviewSectionRequest = 'processes' | 'browser' | 'issues' | 'plan'
export type BrowserPreviewRequest = { sequence: number; target?: string }
export type PreviewState = { tabs: FileItem[]; active: string | null; section: string; browserActive?: string; requests?: Partial<Record<PreviewSectionRequest, number>>; previews: Record<string, FilePreview>; diff: Record<string, boolean>; scroll: Record<string, number>; versions: Record<string, string>; documentPositions?: Record<string, { page?: number; sheet?: number; zoom?: number }> }
export type PreviewMemory = Map<string, PreviewState>
export const emptyPreview = (): PreviewState => ({ tabs: [], active: null, section: 'out', previews: {}, diff: {}, scroll: {}, versions: {} })
/** Opening a panel is a one-shot intent, retained with this chat across remounts. */
export function applyPreviewRequest(state: PreviewState, section: PreviewSectionRequest, sequence: number): PreviewState {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence <= (state.requests?.[section] ?? 0)) return state
  return { ...state, active: null, section, requests: { ...state.requests, [section]: sequence } }
}
/** A source chooses its new tab once; restoring this chat preserves later user selections. */
export function applyBrowserPreviewRequest(state: PreviewState, request: BrowserPreviewRequest): PreviewState {
  const next = applyPreviewRequest(state, 'browser', request.sequence)
  return next === state || !request.target ? next : { ...next, browserActive: request.target }
}
export function trimPreviewMemory(memory: PreviewMemory, currentId: string, currentPath: string | null, limit = 48 * 1024 * 1024) {
  const entries: Array<{ id: string; path: string; bytes: number }> = []
  for (const [id, state] of memory) for (const [path, preview] of Object.entries(state.previews)) entries.push({ id, path, bytes: (preview.dataUrl?.length ?? 0) * 2 + preview.text.length * 2 + JSON.stringify(preview.sheets ?? preview.paragraphs ?? []).length * 2 })
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  for (const entry of entries) {
    if (total <= limit) break
    if (entry.id === currentId && entry.path === currentPath) continue
    const state = memory.get(entry.id)!, previews = { ...state.previews }; delete previews[entry.path]
    memory.set(entry.id, { ...state, previews }); total -= entry.bytes
  }
}
export function openPreview(state: PreviewState, file: FileItem): PreviewState {
  return { ...state, tabs: state.tabs.some(tab => tab.path === file.path) ? state.tabs.map(tab => tab.path === file.path ? file : tab) : [...state.tabs, file], active: file.path, diff: { ...state.diff, [file.path]: !!file.diff && file.kind !== 'new' } }
}
export function closePreview(state: PreviewState, path: string): PreviewState {
  const index = state.tabs.findIndex(tab => tab.path === path), tabs = state.tabs.filter(tab => tab.path !== path)
  const previews = { ...state.previews }, diff = { ...state.diff }, scroll = { ...state.scroll }, versions = { ...state.versions }
  const documentPositions = { ...state.documentPositions }; delete documentPositions[path]
  delete versions[path]; delete previews[path]; delete diff[path]; delete scroll[path + ':content']; delete scroll[path + ':diff']
  for (const key of Object.keys(scroll)) if (key.startsWith(path + ':')) delete scroll[key]
  return { ...state, tabs, active: state.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null : state.active, previews, diff, scroll, versions, documentPositions }
}
