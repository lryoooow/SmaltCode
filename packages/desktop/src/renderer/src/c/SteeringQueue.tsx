import { useRef, useState } from 'react'
import { errorText, store, type SteeringEntry } from '../bridge'
import Popover from './Popover'
import { Btn } from './ui'
import Icon from './icons'

const labels = { pending: '已接收 · 待处理', applied: '已加入任务上下文', cancelled: '已撤回 · 未使用', unused: '任务已结束 · 未使用' }
export default function SteeringQueue({ threadId, entries, onError }: { threadId: string; entries: SteeringEntry[]; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false), [editing, setEditing] = useState<SteeringEntry>(), [text, setText] = useState(''), [busy, setBusy] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null), pending = entries.filter(entry => entry.state === 'pending').length
  const change = async (entry: SteeringEntry, next?: string) => {
    setBusy(true)
    try { await store.changeSteering(threadId, entry, next); setEditing(undefined) }
    catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  if (!entries.length) return null
  return <div className="mb-2"><button ref={anchor} data-testid="steering-queue-toggle" aria-expanded={open} onClick={() => setOpen(!open)} className="status-action"><Icon n="list" s={14} />补充说明{pending ? ` · ${pending} 条待处理` : ' · 查看记录'}</button>
    {open && <Popover anchor={anchor} above width={460} label="补充说明队列" onClose={() => { setOpen(false); setEditing(undefined) }}><div data-testid="steering-queue" className="p-3 space-y-3"><h2 className="font-medium">补充说明</h2><p className="text-[12px] text-[var(--muted)]">在下次模型输入前采用；待处理内容可以编辑或撤回。已加入上下文不代表相关操作已完成。引用使用发送时的快照。</p>{[...entries].reverse().map(entry => <article key={entry.id} data-testid="steering-entry" data-state={entry.state} className="border-t border-[var(--line)] pt-3"><div className="flex gap-2 items-center text-[12px]"><span className={entry.state === 'pending' ? 'text-accent' : 'text-[var(--muted)]'}>{labels[entry.state]}</span><span className="ml-auto text-[var(--muted)]">{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>{editing?.id === entry.id ? <div className="mt-2"><textarea aria-label="编辑补充说明" value={text} maxLength={20000} onChange={e => setText(e.target.value)} className="w-full bg-[var(--sunken)] rounded-lg p-2 min-h-24 text-[13px]" /><div className="flex justify-end gap-2 mt-2"><Btn disabled={busy} onClick={() => setEditing(undefined)}>取消编辑</Btn><Btn v="primary" disabled={busy || !text.trim() || entry.state !== 'pending'} onClick={() => void change(editing, text)}>保存说明</Btn></div>{editing.revision !== entry.revision && <p role="status" className="text-[12px] text-amber-600">状态已变化，请取消编辑并核对最新记录。</p>}</div> : <p className="mt-1 text-[13px] whitespace-pre-wrap break-words">{entry.text}</p>}{!!entry.references?.length && <p className="mt-1 text-[12px] text-[var(--muted)] break-words">引用：{entry.references.map(ref => ref.label ?? ref.path).join('、')}</p>}{entry.state === 'pending' && editing?.id !== entry.id && <div className="flex gap-2 mt-2"><Btn disabled={busy || !entry.editable} onClick={() => { setEditing(entry); setText(entry.text) }}>编辑</Btn><Btn disabled={busy} onClick={() => void change(entry)}>撤回</Btn></div>}</article>)}</div></Popover>}
  </div>
}
