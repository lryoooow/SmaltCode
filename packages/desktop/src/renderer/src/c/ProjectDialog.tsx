import { useEffect, useRef, useState } from 'react'
import { Modal } from './Overlays'
import { Btn } from './ui'
import Icon from './icons'
import { errorText, store, type ProjectMeta } from '../bridge'
import type { FileRoot } from '../../../shared/file-context'

export default function ProjectDialog({ project, onClose, onSaved, onError }: { project?: ProjectMeta; onClose: () => void; onSaved: (p: ProjectMeta) => void; onError: (text: string) => void }) {
  const [name, setName] = useState(project?.name ?? ''), [instructions, setInstructions] = useState(project?.instructions ?? ''), [saving, setSaving] = useState(false)
  const alive = useRef(true)
  const token=useRef<string>(),savedId=useRef(project?.id)
  const [resources,setResources]=useState<{sources:FileRoot[];workspaces:FileRoot[];primary?:string}>(),[loading,setLoading]=useState(!!store.api?.fileContext),[fileError,setFileError]=useState('')
  useEffect(() => { alive.current = true; void store.api?.fileContext?.<any>('project-open',{projectId:project?.id}).then(v=>{if(alive.current){token.current=v.token;setResources(v)}else void store.api?.fileContext?.('project-discard',{token:v.token})}).catch(e=>{if(alive.current)setFileError(errorText(e))}).finally(()=>{if(alive.current)setLoading(false)}); return () => { alive.current = false; if(token.current)void store.api?.fileContext?.('project-discard',{token:token.current}) } }, [])
  const resourceAction=async(action:string,value:Record<string,unknown>={})=>{if(!token.current||saving||loading)return;setLoading(true);setFileError('');try{const v=await store.api!.fileContext!<any>(action,{...value,token:token.current});if(alive.current)setResources(v)}catch(e){if(alive.current)setFileError(errorText(e))}finally{if(alive.current)setLoading(false)}}
  const save=async()=>{setSaving(true);try{if(store.api?.fileContext&&!token.current)throw Error('项目资料设置尚未加载，请关闭后重试');const value=await store.saveProject(savedId.current,{name,instructions});savedId.current=value.id;if(token.current){await store.api!.fileContext!('project-save',{token:token.current,projectId:value.id});token.current=undefined}if(alive.current)onSaved(value)}catch(e){if(alive.current)onError(errorText(e))}finally{if(alive.current)setSaving(false)}}
  return <Modal onClose={()=>{if(!saving)onClose()}} label={project ? '编辑项目' : '创建项目'} w="w-[520px]">
    <form className="p-6 max-h-[85vh] overflow-y-auto" onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="size-10 rounded-xl bg-[var(--accent-soft)] text-accent grid place-items-center mb-4"><Icon n="folder" s={22} /></div>
      <h2 className="text-[20px] font-semibold">{project ? '编辑项目' : '创建项目'}</h2><p className="text-[12px] text-[var(--muted)] mt-1 mb-5">将相关对话归为一组，共用背景与要求。文件继续由本地空间保存。</p>
      <label className="block text-[12px] font-medium mb-1.5" htmlFor="project-name">项目名称</label><input id="project-name" autoFocus maxLength={80} value={name} onChange={e => setName(e.target.value)} className="field w-full" placeholder="例如：产品开发、论文写作" />
      <label className="block text-[12px] font-medium mt-5 mb-1.5" htmlFor="project-instructions">项目说明</label><textarea id="project-instructions" maxLength={20000} rows={4} value={instructions} onChange={e => setInstructions(e.target.value)} className="field w-full resize-y" placeholder="背景、目标、写作风格或工作要求；会用于项目内的对话。" />
      {fileError&&<p role="alert" className="text-[12px] mt-3 text-rose-500">{fileError}</p>}
      {resources&&<div className="mt-5 border-t border-[var(--line)] pt-4 space-y-3 text-[12px]"><h3 className="font-medium">共享资料与工作目录（可选）</h3><p className="text-[var(--muted)] leading-5">资料以只读方式加入新的项目对话；工作目录需要明确采用。修改这里不会改动已有对话的执行环境或搬移文件。</p>{[...resources.sources,...resources.workspaces].map(r=><div key={r.id} className="border border-[var(--line)] rounded-lg p-2"><div className="flex items-center gap-2"><span className="flex-1 min-w-0 truncate">{r.label} · {r.kind==='source'?'只读资料':'可修改目录'}</span><Btn type="button" disabled={loading||saving} onClick={()=>void resourceAction('project-remove',{rootId:r.id})}>移除</Btn></div><p className="text-[11px] text-[var(--muted)] break-all">{r.path}</p></div>)}<div className="flex flex-wrap gap-1"><Btn type="button" v="outline" disabled={loading||saving} onClick={()=>void resourceAction('project-add',{kind:'source',file:true})}>原文件</Btn><Btn type="button" v="outline" disabled={loading||saving} onClick={()=>void resourceAction('project-add',{kind:'source'})}>资料文件夹</Btn><Btn type="button" v="outline" disabled={loading||saving} onClick={()=>void resourceAction('project-add',{kind:'workspace'})}>工作目录</Btn></div>{!!resources.workspaces.length&&<label className="block">建议执行目录<select aria-label="项目建议执行目录" className="field w-full mt-1" disabled={loading||saving} value={resources.primary??''} onChange={e=>void resourceAction('project-primary',{rootId:e.target.value||undefined})}><option value="">使用每段对话的自动本地空间</option>{resources.workspaces.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label>}</div>}
      <div className="flex justify-end gap-2 mt-6"><Btn type="button" disabled={saving} onClick={onClose}>取消</Btn><Btn type="submit" v="primary" disabled={!name.trim() || saving || loading}>{saving ? '保存中…' : project ? '保存项目' : '创建项目'}</Btn></div>
    </form>
  </Modal>
}
