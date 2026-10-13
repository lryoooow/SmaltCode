import { useState } from 'react'
import Icon from './icons'
import { cx, IconBtn, Menu, StatusDot, type Task } from './ui'
import type { ProjectMeta } from '../bridge'

type Action = 'rename' | 'pin' | 'archive' | 'delete' | 'move'
export default function SidebarContents({ tasks, projects, current, project, loading, busy, onOpen, onProject, onNewProject, onEditProject, onDeleteProject, onTask }: {
  tasks: Task[]; projects: ProjectMeta[]; current: string | null; project?: string; loading: boolean; busy: (id: string) => boolean
  onOpen: (id: string) => void; onProject: (id: string) => void; onNewProject: () => void; onEditProject: (id: string) => void; onDeleteProject: (id: string) => void
  onTask: (id: string, action: Action, projectId?: string | null) => void
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const row = (task: Task) => <div key={task.id} className={cx('group relative flex rounded-lg transition', current === task.id ? 'bg-[var(--surface-solid)] shadow-sm' : 'hover:bg-[var(--hover)]')}>
    <button data-testid="task-row" onClick={() => onOpen(task.id)} className="min-w-0 flex-1 flex items-start gap-2 pl-2.5 pr-8 py-2 text-left">
      <span className="mt-[3px]"><StatusDot s={task.status} /></span><span className="min-w-0 flex-1"><span className={cx('block truncate', task.status === 'unread' && 'font-semibold')}>{task.title}</span><span className="block truncate text-[11px] text-[var(--muted)]">{task.ws}</span></span>
    </button>
    <div className="absolute right-1 top-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
      <Menu align="right" trigger={() => <IconBtn n="dots" label={'对话操作 ' + task.title} />} items={[
        { label: '重命名', icon: 'file', onClick: () => onTask(task.id, 'rename') },
        { label: task.pinned ? '取消置顶' : '置顶', icon: 'pin', onClick: () => onTask(task.id, 'pin') },
        { label: '归档', icon: 'archive', disabled: busy(task.id), onClick: () => onTask(task.id, 'archive') },
        { label: '-' },
        ...projects.map(p => ({ label: '移至 ' + p.name, icon: 'folder', disabled: busy(task.id), onClick: () => onTask(task.id, 'move', p.id) })),
        { label: '移出项目', icon: 'chat', disabled: busy(task.id), onClick: () => onTask(task.id, 'move', null) },
        { label: '-' }, { label: '删除对话', icon: 'trash', danger: true, disabled: busy(task.id), onClick: () => onTask(task.id, 'delete') },
      ]} />
    </div>
  </div>
  const ungrouped = tasks.filter(t => !t.projectId)
  return <div className="flex-1 overflow-y-auto px-2.5 mt-4 pb-4">
    <div className="flex items-center justify-between px-2.5 h-7 text-[11px] font-medium text-[var(--muted)]"><span>项目</span><IconBtn n="plus" label="创建项目" onClick={onNewProject} /></div>
    {!projects.length && <button onClick={onNewProject} className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[12px] text-[var(--muted)] hover:bg-[var(--hover)]"><Icon n="folderPlus" s={15} />创建项目，组织对话</button>}
    {projects.map(p => <div key={p.id} className="mb-1" data-testid="project-group">
      <div className={cx('group flex items-center gap-1 rounded-lg', project === p.id && 'bg-[var(--accent-soft)]')}>
        <button aria-label={(closed[p.id] ? '展开项目 ' : '收起项目 ') + p.name} onClick={() => setClosed(c => ({ ...c, [p.id]: !c[p.id] }))} className="p-1 text-[var(--muted)]"><Icon n="chevron" s={12} className={cx(!closed[p.id] && 'rotate-90')} /></button>
        <button onClick={() => onProject(p.id)} className="min-w-0 flex-1 flex items-center gap-2 py-2 text-left"><Icon n="folder" s={16} className="shrink-0 text-accent" /><span className="truncate font-medium">{p.name}</span></button>
        <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><Menu align="right" trigger={() => <IconBtn n="dots" label={'项目操作 ' + p.name} />} items={[
          { label: '编辑项目', icon: 'file', onClick: () => onEditProject(p.id) },
          { label: '删除项目', icon: 'trash', danger: true, onClick: () => onDeleteProject(p.id) },
        ]} /></div>
      </div>
      {!closed[p.id] && <div className="ml-3 pl-1 border-l border-[var(--line)]">{tasks.filter(t => t.projectId === p.id).map(row)}{!tasks.some(t => t.projectId === p.id) && <button onClick={() => onProject(p.id)} className="text-[11px] text-[var(--muted)] px-3 py-2">开始第一段对话</button>}</div>}
    </div>)}
    <div className="mt-5">
      {!ungrouped.length && !projects.length && <div className="px-3 py-4 text-[12px] text-[var(--muted)]">{loading ? '正在加载对话…' : '从右侧输入开始新的对话。'}</div>}
      {['置顶', '进行中', '今天', '昨天', '近 7 天', '更早'].map(group => {
        const list = ungrouped.filter(t => t.group === group)
        return list.length ? <div key={group} className="mb-3"><div className="px-2.5 h-6 flex items-center text-[11px] font-medium text-[var(--muted)]/80">{group}</div>{list.map(row)}</div> : null
      })}
    </div>
  </div>
}
