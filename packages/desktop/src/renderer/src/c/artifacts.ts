import type { Session } from '../bridge'
import type { FileItem } from './Task'
const folderName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path
export function artifacts(session: Session, turnId?: string): FileItem[] {
  const files = new Map<string, FileItem>()
  session.items.forEach(item => {
    if (turnId && item.turnId !== turnId) return
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
