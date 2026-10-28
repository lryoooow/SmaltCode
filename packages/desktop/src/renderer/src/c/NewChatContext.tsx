import { useRef, useState } from 'react'
import type { ProjectMeta } from '../bridge'
import Popover from './Popover'
import { Btn } from './ui'
import Icon from './icons'
export default function NewChatContext({projects,project,disabled,onProject,onEditProject}:{projects:ProjectMeta[];project?:ProjectMeta;disabled:boolean;onProject:(id?:string)=>void;onEditProject:()=>void}) {
  const [open,setOpen]=useState(false),anchor=useRef<HTMLButtonElement>(null)
  return <div data-testid="new-chat-context" className="min-w-0"><button ref={anchor} type="button" aria-label="选择对话所属项目" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(v=>!v)} className="inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)]"><Icon n={project?'folder':'chat'} s={13}/><span data-testid="context-project-name" className="truncate">{project?.name??'不加入项目'}</span><Icon n="down" s={11}/></button>{open&&<Popover anchor={anchor} label="对话所属项目" above width={320} onClose={()=>setOpen(false)} testId="new-chat-context-panel"><div className="p-4 space-y-3"><label className="block text-[12px]">所属项目（可选）<select autoFocus aria-label="新对话所属项目" value={project?.id??''} className="field w-full mt-2" onChange={e=>{onProject(e.target.value||undefined);setOpen(false)}}><option value="">不加入项目</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><p className="text-[11px] text-[var(--muted)] leading-5">归集对话、共用说明与资料。执行目录需单独选择，产物保留在每段对话的本地空间。</p>{project&&<Btn onClick={()=>{setOpen(false);onEditProject()}}>项目设置</Btn>}</div></Popover>}</div>
}
