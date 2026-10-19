import { useEffect, useRef, useState } from 'react'
import Icon from './icons'
import { Btn, Menu, MODES, cx } from './ui'
import { errorText, folderName, store, type ContextReference, type Skill, type FilePreview } from '../bridge'
import { ContextTray, FileMentions, mentionAt, type Mention } from './ContextFiles'
import DocumentView from './DocumentView'
import { Modal } from './Overlays'
import { PROVIDER_NAMES } from './Overlays'
import ModelPicker from './ModelPicker'
import type { ModelChoice } from './model-choices'

export type { ModelChoice } from './model-choices'
export default function Composer({ big, running, disabled, onSend, onStop, value, setValue, mode, setMode, model, setModel, models, ws, queued = 0, onError, onResetPermissions, approvedCategories, references = [], onReferencesChange, onPreview }: {
  big?: boolean; running?: boolean; disabled?: boolean; onSend: (text: string) => Promise<void>; onStop?: () => void
  value: string; setValue: (value: string) => void; mode: string; setMode: (mode: string) => void
  model: string; setModel: (model: string) => void; models: ModelChoice[]; ws?: string; queued?: number; onError: (message: string) => void
  references?: ContextReference[]; onReferencesChange?: (refs: ContextReference[]) => void
  onResetPermissions?: () => void; approvedCategories?: string[]
  onPreview?: (ref: ContextReference) => void
}) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const [focus, setFocus] = useState(false)
  const [mention, setMention] = useState<Mention>()
  const choose = (path: string) => {
    if (!mention || !ws) return
    if (references.length >= 10) { onError('最多引用 10 项资料'); return }
    const absolute = ws.replace(/\\/g, '/').replace(/\/$/, '') + '/' + path
    if (!references.some(ref => ref.path === absolute && ref.start === undefined)) onReferencesChange?.([...references, { path: absolute, label: path }])
    setValue(value.slice(0, mention.start) + value.slice(mention.end)); setMention(undefined); ta.current?.focus()
  }
  const [sending, setSending] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const [adding, setAdding] = useState(false), [skillMenu, setSkillMenu] = useState(false), [skills, setSkills] = useState<Skill[]>([]), [skillLoading, setSkillLoading] = useState(false)
  const [preview, setPreview] = useState<{ name: string; file?: FilePreview; text?: string; loading: boolean; error?: string }>()
  const alive = useRef(true), latestRefs = useRef(references), previewRequest = useRef(0)
  latestRefs.current = references
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const add = (refs: ContextReference[]) => {
    const current = latestRefs.current, next = [...current, ...refs.filter(ref => !current.some(value => value.path === ref.path))]
    if (next.length > 10) onError('最多引用 10 项资料，超出的文件未加入本次消息')
    onReferencesChange?.(next.slice(0, 10))
  }
  const showPreview = async (ref: ContextReference) => {
    if (onPreview && !ref.path.startsWith('skill:')) { onPreview(ref); return }
    const request = ++previewRequest.current
    const name = ref.label ?? folderName(ref.path); setPreview({ name, loading: true })
    try {
      if (ref.path.startsWith('skill:')) {
        const skill = await store.api!.skills<Skill & { text: string }>('read', { id: ref.path.slice(6) })
        if (alive.current && request === previewRequest.current) setPreview({ name, text: skill.text, loading: false })
      } else {
        const file = ref.path.startsWith('attachment:') ? await store.api!.attachment(ref.path.slice(11)) : await store.api!.previewFile(ws!, ref.path)
        if (alive.current && request === previewRequest.current) setPreview({ name, file, loading: false })
      }
    } catch (error) { if (alive.current && request === previewRequest.current) setPreview({ name, loading: false, error: errorText(error) }) }
  }
  const closePreview = () => { ++previewRequest.current; setPreview(undefined) }
  const openSkills = async () => {
    setSkillMenu(value => !value); setSkillLoading(true)
    try { const list = await store.api!.skills<Skill[]>('list'); if (alive.current) setSkills(list.filter(skill => skill.enabled)) }
    catch (e) { onError(errorText(e)) } finally { if (alive.current) setSkillLoading(false) }
  }
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, big ? 220 : 160) + 'px' } }, [value, big])
  const permission = MODES.find(m => m.id === mode) ?? MODES[0]
  const send = async () => {
    if (!value.trim() || sending || disabled || adding) return
    setSending(true)
    try {
      await onSend(value.trim())
      setValue(''); setMention(undefined)
    } catch (err) { onError(errorText(err)) } finally { setSending(false); ta.current?.focus() }
  }
  const pick = async () => {
    setAdding(true)
    try { const result = await store.api!.pickAttachments(); if (alive.current) { add(result.attachments.map(file => ({ path: 'attachment:' + file.id, digest: file.digest, label: file.name }))); if (result.errors.length) onError(result.errors.join('；')) } }
    catch (err) { if (alive.current) onError(errorText(err)) } finally { if (alive.current) setAdding(false) }
  }
  const paste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const image = [...event.clipboardData.files].find(file => ['image/png', 'image/jpeg'].includes(file.type))
    if (!image) return
    event.preventDefault(); if (adding) return
    if (image.size > 8 * 1024 * 1024) { onError('图片超过 8 MB，请压缩后添加'); return }
    setAdding(true)
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(image) })
      const file = await store.api!.pasteImage(data, image.type)
      if (alive.current) add([{ path: 'attachment:' + file.id, digest: file.digest, label: file.name }])
    } catch (e) { if (alive.current) onError(errorText(e)) } finally { if (alive.current) setAdding(false) }
  }
  return <div data-testid="composer" className="relative">
    {mention && <FileMentions ws={ws} mention={mention} onChoose={choose} onClose={() => setMention(undefined)} />}
    <div className={cx('relative rounded-2xl border bg-[var(--surface-solid)] transition-all duration-200', focus ? 'border-accent/50 shadow-[0_0_0_4px_rgba(47,79,208,.10),0_12px_40px_-12px_rgba(20,30,80,.25)]' : 'border-[var(--line)] shadow-[0_8px_30px_-14px_rgba(20,30,80,.2)]')}>
      {mode === 'bypassPermissions' && <div className="flex items-center gap-2 px-4 pt-2.5 text-[12px] text-rose-500"><Icon n="alert" s={13} />跳过操作审批，工作区与敏感路径限制仍生效</div>}
      <ContextTray refs={references} onChange={refs => onReferencesChange?.(refs)} onPreview={ref => void showPreview(ref)} />
      {adding && <div role="status" className="px-4 pt-2 text-[11px] text-[var(--muted)]">正在添加并检查资料…</div>}
      <textarea ref={ta} aria-label="任务输入" value={value} rows={big ? 3 : 1} disabled={disabled || sending} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={e => { setValue(e.target.value); setMention(mentionAt(e.target.value, e.target.selectionStart)) }}
        onPaste={e => { void paste(e) }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void send() } }}
        placeholder={running ? '补充说明，将在当前步骤后处理…' : big ? '描述你想完成的工作，输入 @ 引用文件…' : '继续对话，输入 @ 引用文件…'}
        className={cx('block w-full resize-none bg-transparent outline-none placeholder:text-[var(--muted)]/70 leading-relaxed disabled:opacity-60', big ? 'px-4 pt-4 text-[15px]' : 'px-4 pt-3 text-[14px]')} />
      <div className="flex items-center gap-1 p-2 flex-wrap">
        <button aria-label="添加文件引用" title="添加 PNG/JPEG、PDF、Word、Excel 或文本，也可粘贴截图" disabled={disabled || sending || adding} onClick={() => void pick()} className="size-8 grid place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40"><Icon n="paperclip" s={17} /></button>
        <button aria-label="选择技能" aria-expanded={skillMenu} disabled={disabled || sending} onClick={() => void openSkills()} className="h-8 px-2 flex items-center gap-1.5 rounded-lg text-[12px] text-[var(--muted)] hover:bg-[var(--hover)]"><Icon n="spark" s={14} /><span className="hidden sm:inline">技能</span></button>
        <Menu up trigger={() => <button aria-label="权限模式" disabled={disabled} title={running ? '运行中也可调整，立即影响后续操作' : '调整本对话的操作权限'} className={cx('h-8 px-2 flex items-center gap-1.5 rounded-lg text-[12px] hover:bg-[var(--hover)] disabled:opacity-50', permission.danger ? 'text-rose-500' : 'text-[var(--muted)]')}><Icon n={permission.icon} s={14} />{permission.label}<Icon n="down" s={12} /></button>}
          items={[...MODES.map(m => ({ label: m.label, desc: m.desc, icon: m.icon, sel: m.id === mode, danger: m.danger, disabled, onClick: () => m.danger ? setConfirmBypass(true) : setMode(m.id) })), ...(onResetPermissions ? [{ label: '-' }, { label: '撤销本对话额外许可', desc: '清除记住的许可，保留所选权限模式', icon: 'refresh', onClick: onResetPermissions }] : [])]} />
        {!!approvedCategories?.length && <span title="可在权限菜单中撤销" className="text-[10.5px] text-accent px-1">已允许{approvedCategories.map(c => ({ edit: '编辑', shell: '命令', read: '读取' }[c] ?? c)).join('、')}</span>}
        {ws && !big && <span title={ws} className="hidden xl:flex items-center gap-1 text-[11px] text-[var(--muted)] max-w-28 truncate"><Icon n="folder" s={12} />{folderName(ws)}</span>}
        <div className="flex-1" />
        {queued > 0 && <span className="text-[11px] text-[var(--muted)]">{queued} 条待处理</span>}
        <ModelPicker value={model} choices={models} onChange={setModel} disabled={running || disabled} names={PROVIDER_NAMES} />
        {running && <button onClick={onStop} aria-label="停止" className="size-8 grid place-items-center rounded-lg bg-[var(--text)] text-[var(--bg)] hover:opacity-85"><Icon n="stop" s={13} w={2.4} /></button>}
        <button onClick={() => void send()} disabled={!value.trim() || sending || disabled || adding} aria-label={running ? '发送补充说明' : '发送'} className="size-8 grid place-items-center rounded-lg bg-accent text-white disabled:bg-[var(--line)] disabled:text-[var(--muted)] hover:brightness-110 transition"><Icon n="send" s={15} w={2.2} /></button>
      </div>
    </div>
    {confirmBypass && <Modal w="w-[400px]" label="确认跳过审批" onClose={() => setConfirmBypass(false)}><div className="p-5"><div className="size-10 rounded-xl bg-rose-500/10 text-rose-500 grid place-items-center mb-3"><Icon n="alert" s={20} /></div><div className="text-[15px] font-semibold">切换到跳过审批？</div><p className="mt-2 text-[var(--muted)] leading-relaxed">命令和文件修改将无需逐次确认。请确认你信任当前任务与工作文件夹。</p><div className="flex justify-end gap-2 mt-5"><Btn v="outline" onClick={() => setConfirmBypass(false)}>取消</Btn><Btn v="danger" onClick={() => { setMode('bypassPermissions'); setConfirmBypass(false) }}>确认切换</Btn></div></div></Modal>}
    {skillMenu && <><div className="fixed inset-0 z-30" onClick={() => setSkillMenu(false)} /><div role="listbox" aria-label="选择任务技能" className="absolute bottom-12 left-3 z-40 w-80 max-w-[85vw] max-h-72 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--surface-solid)] shadow-xl p-1.5"><div className="px-3 py-2 text-[11px] text-[var(--muted)]">选择本次工作流程 · 最多 3 项</div>{skillLoading ? <div className="p-3 text-[var(--muted)]">正在读取…</div> : skills.length ? skills.map(skill => <button key={skill.id} role="option" aria-selected={references.some(ref => ref.path === 'skill:' + skill.id)} onClick={() => { if (references.some(ref => ref.path === 'skill:' + skill.id)) onReferencesChange?.(references.filter(ref => ref.path !== 'skill:' + skill.id)); else if (references.filter(ref => ref.path.startsWith('skill:')).length >= 3) onError('每条消息最多选择 3 个技能'); else add([{ path: 'skill:' + skill.id, label: skill.name, digest: skill.digest }]); setSkillMenu(false); ta.current?.focus() }} className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--hover)]"><div className="font-medium">{skill.name}{references.some(ref => ref.path === 'skill:' + skill.id) ? ' ✓' : ''}</div><p className="mt-1 text-[11px] text-[var(--muted)] line-clamp-2">{skill.description}</p></button>) : <div className="p-3 text-[var(--muted)]">暂无已启用技能，可前往侧栏“技能”导入并启用。</div>}</div></>}
    {preview && <Modal label="资料预览" onClose={closePreview} w="w-[740px]"><div className="p-5 flex flex-col max-h-[85vh]"><div className="flex items-center justify-between gap-3 mb-3"><h2 className="font-semibold truncate">{preview.name}</h2><Btn onClick={closePreview}>关闭</Btn></div><div className="min-h-0 overflow-auto">{preview.loading ? <div role="status" className="p-8 text-[var(--muted)]">正在打开资料…</div> : preview.error ? <div role="alert" className="text-rose-500 break-words">{preview.error}</div> : preview.text ? <pre className="text-[12px] whitespace-pre-wrap break-words">{preview.text}</pre> : preview.file ? <DocumentView preview={preview.file} name={preview.name} /> : null}</div></div></Modal>}
  </div>
}
