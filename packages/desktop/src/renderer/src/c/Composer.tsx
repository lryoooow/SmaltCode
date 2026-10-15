import { useEffect, useRef, useState } from 'react'
import Icon from './icons'
import { Btn, Menu, MODES, cx } from './ui'
import { errorText, folderName, store, type ContextReference } from '../bridge'
import { ContextTray, FileMentions, mentionAt, type Mention } from './ContextFiles'

export type ModelChoice = { id: string; label: string }
export default function Composer({ big, running, disabled, onSend, onStop, value, setValue, mode, setMode, model, setModel, models, ws, queued = 0, onError, onResetPermissions, approvedCategories, references = [], onReferencesChange }: {
  big?: boolean; running?: boolean; disabled?: boolean; onSend: (text: string) => Promise<void>; onStop?: () => void
  value: string; setValue: (value: string) => void; mode: string; setMode: (mode: string) => void
  model: string; setModel: (model: string) => void; models: ModelChoice[]; ws?: string; queued?: number; onError: (message: string) => void
  references?: ContextReference[]; onReferencesChange?: (refs: ContextReference[]) => void
  onResetPermissions?: () => void; approvedCategories?: string[]
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
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, big ? 220 : 160) + 'px' } }, [value, big])
  const permission = MODES.find(m => m.id === mode) ?? MODES[0]
  const send = async () => {
    if (!value.trim() || sending || disabled) return
    setSending(true)
    try {
      await onSend(value.trim())
      setValue(''); setMention(undefined)
    } catch (err) { onError(errorText(err)) } finally { setSending(false); ta.current?.focus() }
  }
  const pick = async () => {
    try { const paths = await store.api!.pickFiles(); onReferencesChange?.([...references, ...paths.filter(path => !references.some(ref => ref.path === path)).map(path => ({ path, label: folderName(path) }))].slice(0, 10)) }
    catch (err) { onError(errorText(err)) }
  }
  return <div data-testid="composer" className="relative">
    {mention && <FileMentions ws={ws} mention={mention} onChoose={choose} onClose={() => setMention(undefined)} />}
    <div className={cx('relative rounded-2xl border bg-[var(--surface-solid)] transition-all duration-200', focus ? 'border-accent/50 shadow-[0_0_0_4px_rgba(47,79,208,.10),0_12px_40px_-12px_rgba(20,30,80,.25)]' : 'border-[var(--line)] shadow-[0_8px_30px_-14px_rgba(20,30,80,.2)]')}>
      {mode === 'bypassPermissions' && <div className="flex items-center gap-2 px-4 pt-2.5 text-[12px] text-rose-500"><Icon n="alert" s={13} />跳过操作审批，工作区与敏感路径限制仍生效</div>}
      <ContextTray refs={references} onChange={refs => onReferencesChange?.(refs)} />
      <textarea ref={ta} aria-label="任务输入" value={value} rows={big ? 3 : 1} disabled={disabled || sending} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={e => { setValue(e.target.value); setMention(mentionAt(e.target.value, e.target.selectionStart)) }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        placeholder={running ? '补充说明，将在当前步骤后处理…' : big ? '描述你想完成的工作，输入 @ 引用文件…' : '继续对话，输入 @ 引用文件…'}
        className={cx('block w-full resize-none bg-transparent outline-none placeholder:text-[var(--muted)]/70 leading-relaxed disabled:opacity-60', big ? 'px-4 pt-4 text-[15px]' : 'px-4 pt-3 text-[14px]')} />
      <div className="flex items-center gap-1 p-2 flex-wrap">
        <button aria-label="添加文件引用" title="引用工作区文本文件：每个完整文件最多 24000 字符，也可在预览中选择片段" disabled={disabled || sending} onClick={() => void pick()} className="size-8 grid place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-40"><Icon n="paperclip" s={17} /></button>
        <Menu up trigger={() => <button aria-label="权限模式" disabled={disabled} title={running ? '运行中也可调整，立即影响后续操作' : '调整本对话的操作权限'} className={cx('h-8 px-2 flex items-center gap-1.5 rounded-lg text-[12px] hover:bg-[var(--hover)] disabled:opacity-50', permission.danger ? 'text-rose-500' : 'text-[var(--muted)]')}><Icon n={permission.icon} s={14} />{permission.label}<Icon n="down" s={12} /></button>}
          items={[...MODES.map(m => ({ label: m.label, desc: m.desc, icon: m.icon, sel: m.id === mode, danger: m.danger, disabled, onClick: () => m.danger ? setConfirmBypass(true) : setMode(m.id) })), ...(onResetPermissions ? [{ label: '-' }, { label: '撤销本对话额外许可', desc: '清除记住的许可，保留所选权限模式', icon: 'refresh', onClick: onResetPermissions }] : [])]} />
        {!!approvedCategories?.length && <span title="可在权限菜单中撤销" className="text-[10.5px] text-accent px-1">已允许{approvedCategories.map(c => ({ edit: '编辑', shell: '命令', read: '读取' }[c] ?? c)).join('、')}</span>}
        {ws && !big && <span title={ws} className="hidden xl:flex items-center gap-1 text-[11px] text-[var(--muted)] max-w-28 truncate"><Icon n="folder" s={12} />{folderName(ws)}</span>}
        <div className="flex-1" />
        {queued > 0 && <span className="text-[11px] text-[var(--muted)]">{queued} 条待处理</span>}
        <Menu up align="right" trigger={() => <button aria-label="选择模型" disabled={running || disabled} title={model} className="h-8 max-w-44 px-2 flex items-center gap-1.5 rounded-lg text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] disabled:opacity-50"><Icon n="cpu" s={14} /><span className="truncate">{model.split('/').slice(1).join('/') || '配置模型'}</span><Icon n="down" s={12} /></button>}
          items={models.map(m => ({ label: m.label, sel: m.id === model, disabled: running || disabled, onClick: () => setModel(m.id) }))} />
        {running && <button onClick={onStop} aria-label="停止" className="size-8 grid place-items-center rounded-lg bg-[var(--text)] text-[var(--bg)] hover:opacity-85"><Icon n="stop" s={13} w={2.4} /></button>}
        <button onClick={() => void send()} disabled={!value.trim() || sending || disabled} aria-label={running ? '发送补充说明' : '发送'} className="size-8 grid place-items-center rounded-lg bg-accent text-white disabled:bg-[var(--line)] disabled:text-[var(--muted)] hover:brightness-110 transition"><Icon n="send" s={15} w={2.2} /></button>
      </div>
    </div>
    {confirmBypass && <div className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm" onClick={() => setConfirmBypass(false)}><div role="dialog" aria-modal="true" aria-label="确认跳过审批" onClick={e => e.stopPropagation()} className="w-[400px] max-w-[92vw] p-5 rounded-2xl bg-[var(--surface-solid)] border border-[var(--line)] shadow-2xl"><div className="size-10 rounded-xl bg-rose-500/10 text-rose-500 grid place-items-center mb-3"><Icon n="alert" s={20} /></div><div className="text-[15px] font-semibold">切换到跳过审批？</div><p className="mt-2 text-[var(--muted)] leading-relaxed">命令和文件修改将无需逐次确认。请确认你信任当前任务与工作文件夹。</p><div className="flex justify-end gap-2 mt-5"><Btn v="outline" onClick={() => setConfirmBypass(false)}>取消</Btn><Btn v="danger" onClick={() => { setMode('bypassPermissions'); setConfirmBypass(false) }}>确认切换</Btn></div></div></div>}
  </div>
}
