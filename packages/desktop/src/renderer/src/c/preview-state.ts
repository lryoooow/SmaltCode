import type { FileItem } from './Task'
import type { FilePreview } from '../bridge'
export type PreviewState = { tabs: FileItem[]; active: string | null; section: string; previews: Record<string, FilePreview>; diff: Record<string, boolean>; scroll: Record<string, number>; versions: Record<string, string> }
export type PreviewMemory = Map<string, PreviewState>
export const emptyPreview = (): PreviewState => ({ tabs: [], active: null, section: 'out', previews: {}, diff: {}, scroll: {}, versions: {} })
export function openPreview(state: PreviewState, file: FileItem): PreviewState {
  return { ...state, tabs: state.tabs.some(tab => tab.path === file.path) ? state.tabs.map(tab => tab.path === file.path ? file : tab) : [...state.tabs, file], active: file.path, diff: { ...state.diff, [file.path]: !!file.diff && file.kind !== 'new' } }
}
export function closePreview(state: PreviewState, path: string): PreviewState {
  const index = state.tabs.findIndex(tab => tab.path === path), tabs = state.tabs.filter(tab => tab.path !== path)
  const previews = { ...state.previews }, diff = { ...state.diff }, scroll = { ...state.scroll }, versions = { ...state.versions }
  delete versions[path]; delete previews[path]; delete diff[path]; delete scroll[path + ':content']; delete scroll[path + ':diff']
  return { ...state, tabs, active: state.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null : state.active, previews, diff, scroll, versions }
}
