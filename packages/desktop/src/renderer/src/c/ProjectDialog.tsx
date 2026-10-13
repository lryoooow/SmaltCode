import { useState } from 'react'
import { Modal } from './Overlays'
import { Btn } from './ui'
import Icon from './icons'
import { errorText, folderName, store, type ProjectMeta } from '../bridge'

export default function ProjectDialog({ project, workspace, onClose, onSaved, onError }: { project?: ProjectMeta; workspace: string; onClose: () => void; onSaved: (p: ProjectMeta) => void; onError: (text: string) => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [instructions, setInstructions] = useState(project?.instructions ?? '')
  const [cwd, setCwd] = useState(project?.cwd ?? workspace)
  const [saving, setSaving] = useState(false)
  const pick = async () => { try { const result = await store.api!.pickFolder(cwd || undefined); if (!result.canceled) setCwd(result.dir); else if (result.reason) onError(result.reason) } catch (e) { onError(errorText(e)) } }
  return <Modal onClose={onClose} label={project ? '编辑项目' : '创建项目'} w="w-[520px]">
    <form className="p-6" onSubmit={e => { e.preventDefault(); setSaving(true); void store.saveProject(project?.id, { name, instructions, cwd: cwd || null }).then(onSaved).catch(e => onError(errorText(e))).finally(() => setSaving(false)) }}>
      <div className="size-10 rounded-xl bg-[var(--accent-soft)] text-accent grid place-items-center mb-4"><Icon n="folder" s={22} /></div>
      <h2 className="text-[20px] font-semibold">{project ? '编辑项目' : '创建项目'}</h2><p className="text-[12px] text-[var(--muted)] mt-1 mb-5">把相关对话放在一起，共用项目说明和工作文件夹。</p>
      <label className="block text-[12px] font-medium mb-1.5" htmlFor="project-name">项目名称</label><input id="project-name" autoFocus maxLength={80} value={name} onChange={e => setName(e.target.value)} className="field w-full" placeholder="例如：产品开发、论文写作" />
      <label className="block text-[12px] font-medium mt-5 mb-1.5" htmlFor="project-instructions">项目说明</label><textarea id="project-instructions" maxLength={20000} rows={4} value={instructions} onChange={e => setInstructions(e.target.value)} className="field w-full resize-y" placeholder="背景、目标、写作风格或工作要求；会用于项目内的对话。" />
      <div className="text-[12px] font-medium mt-5 mb-1.5">默认工作文件夹</div><div className="flex items-center gap-2"><button type="button" onClick={() => void pick()} title={cwd} className="field min-w-0 flex-1 flex items-center gap-2 text-left"><Icon n="folder" s={15} /><span className="truncate">{cwd ? folderName(cwd) : '选择文件夹（可稍后设置）'}</span></button>{cwd && <Btn type="button" v="ghost" onClick={() => setCwd('')}>清除</Btn>}</div>
      <div className="flex justify-end gap-2 mt-6"><Btn type="button" onClick={onClose}>取消</Btn><Btn type="submit" v="primary" disabled={!name.trim() || saving}>{saving ? '保存中…' : project ? '保存项目' : '创建项目'}</Btn></div>
    </form>
  </Modal>
}
