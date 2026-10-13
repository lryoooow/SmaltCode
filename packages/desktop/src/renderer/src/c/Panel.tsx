import { useEffect, useState } from 'react'
import Icon from './icons'
import { FileIcon, type FileItem } from './Task'
import { cx, IconBtn, Btn } from './ui'
import { errorText, store, type Session, type FilePreview } from '../bridge'
import Md from './Markdown'

export default function Panel({ files, sel, setSel, onClose, session, onError }: { files: FileItem[]; sel: FileItem | null; setSel: (file: FileItem | null) => void; onClose: () => void; session: Session; onError: (message: string) => void }) {
  const [tab, setTab] = useState('out')
  const [preview, setPreview] = useState<FilePreview>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  useEffect(() => {
    setPreview(undefined); setError(undefined); setShowDiff(sel?.kind === 'mod')
    if (!sel || sel.kind === 'del') return
    let alive = true
    setLoading(true)
    store.api!.file(session.meta.id, sel.path, 'read').then(result => { if (alive) setPreview(result) }).catch(err => { if (alive) setError(errorText(err)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [session.meta.id, sel?.path])
  const reveal = async () => { if (sel) try { await store.api!.file(session.meta.id, sel.path, 'reveal') } catch (err) { onError(errorText(err)) } }
  const copy = async () => { try { await navigator.clipboard.writeText(session.meta.cwd.replace(/\\/g, '/') + '/' + sel!.path) } catch (err) { onError(errorText(err)) } }
  const tabs = [['out', '产物', files.filter(f => f.kind === 'new').length], ['chg', '变更', files.length], ['prog', '进度', 0]] as const
  const summary = session.summaries.at(-1)
  const toolCount = session.items.filter(i => i.kind === 'commandExecution' || i.kind === 'fileChange').length
  const usage = session.usage
  if (sel) return <aside data-testid="file-preview" className="detail-panel w-[380px] shrink-0 border-l border-[var(--line)] bg-[var(--surface-solid)] flex flex-col min-h-0">
    <div className="h-11 flex items-center gap-2 px-3 border-b border-[var(--line)] shrink-0">
      <IconBtn n="chevron" label="返回产物列表" onClick={() => setSel(null)} className="rotate-180" /><FileIcon name={sel.name} s={20} /><span className="font-medium truncate">{sel.name}</span><span className="flex-1" />
      <IconBtn n="copy" label="复制路径" onClick={() => void copy()} /><IconBtn n="folder" label="在资源管理器中显示" onClick={() => void reveal()} /><IconBtn n="x" label="关闭面板" onClick={onClose} />
    </div>
    <div className="px-3 py-2 text-[11px] text-[var(--muted)] border-b border-[var(--line)] break-all">{sel.path}</div>
    {sel.diff && <div className="flex gap-1 px-3 py-2 border-b border-[var(--line)]"><Btn v={showDiff ? 'soft' : 'ghost'} onClick={() => setShowDiff(true)}>变更 diff</Btn>{sel.kind !== 'del' && <Btn v={!showDiff ? 'soft' : 'ghost'} onClick={() => setShowDiff(false)}>文件内容</Btn>}</div>}
    <div className="flex-1 overflow-auto min-h-0">
      {showDiff && sel.diff ? <div className="font-mono text-[11.5px] leading-[1.8] py-2">{sel.diff.split('\n').map((line, i) => <div key={i} className={cx('flex px-2', line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', line.startsWith('-') && !line.startsWith('---') && 'bg-rose-500/10 text-rose-600 dark:text-rose-300')}><span className="w-8 shrink-0 text-right pr-2 text-[var(--muted)]/60 select-none">{i + 1}</span><span className="whitespace-pre">{line || ' '}</span></div>)}</div>
        : sel.kind === 'del' ? <div className="p-5 text-[var(--muted)]">文件已删除。</div>
        : loading ? <div className="p-5 text-[var(--muted)]">正在读取文件…</div>
        : error ? <div role="alert" className="p-5 text-rose-500">{error}</div>
        : preview?.binary ? <div className="p-6 text-center"><FileIcon name={sel.name} s={48} /><p className="mt-4 text-[var(--muted)]">{preview.reason ?? '此格式请使用本机应用查看。'}</p><p className="my-3 text-[12px] text-[var(--muted)]">{(preview.size / 1024).toFixed(1)} KB</p><Btn v="outline" onClick={() => void reveal()}><Icon n="folder" s={14} />在资源管理器中显示</Btn></div>
        : preview ? sel.name.endsWith('.md') ? <div className="p-5"><Md text={preview.text} /></div> : <pre className="p-4 font-mono text-[12px] whitespace-pre-wrap break-all">{preview.text || '空文件'}</pre> : null}
    </div>
  </aside>
  return <aside data-testid="artifact-panel" className="detail-panel w-[300px] shrink-0 border-l border-[var(--line)] bg-[var(--surface-solid)]/60 flex flex-col min-h-0">
    <div className="h-11 flex items-center gap-1 px-2 border-b border-[var(--line)] shrink-0"><div className="flex p-0.5 rounded-lg bg-[var(--sunken)]">{tabs.map(([id, label, count]) => <button key={id} onClick={() => setTab(id)} className={cx('h-7 px-3 rounded-md text-[12.5px] flex items-center gap-1.5 transition', tab === id ? 'bg-[var(--surface-solid)] shadow-sm font-medium' : 'text-[var(--muted)]')}>{label}{count > 0 && <span className="text-[10px] min-w-4 h-4 px-1 rounded-full bg-accent/12 text-accent grid place-items-center">{count}</span>}</button>)}</div><span className="flex-1" /><IconBtn n="x" label="收起面板" onClick={onClose} /></div>
    <div className="flex-1 overflow-y-auto p-2">
      {tab === 'prog' ? <div className="p-3 space-y-4">{[
        ['最近一轮用时', summary ? (summary.durationMs / 1000).toFixed(1) + ' 秒' : '—'],
        ['累计 Token', usage ? (usage.totalInputTokens + usage.totalOutputTokens).toLocaleString() : '—'],
        ['最近一轮工具调用', summary ? summary.toolCount + ' 次' : '—'],
        ['文件变更', files.length + ' 个'],
      ].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-[var(--muted)]">{label}</span><span className="font-medium tabular-nums">{value}</span></div>)}<div><div className="flex justify-between text-[12px] mb-2"><span className="text-[var(--muted)]">上下文占用</span><span>{usage ? Math.round(usage.contextUsage * 100) + '%' : '—'}</span></div><div className="h-1.5 rounded-full bg-[var(--sunken)]"><div className="h-full rounded-full bg-accent" style={{ width: (usage ? usage.contextUsage * 100 : 0) + '%' }} /></div></div></div>
        : (() => { const list = tab === 'out' ? files.filter(f => f.kind === 'new') : files
          return list.length ? list.map(f => <button key={f.path} onClick={() => setSel(f)} className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--hover)] transition text-left group"><FileIcon name={f.name} s={32} /><div className="flex-1 min-w-0"><div className="font-medium truncate">{f.name}</div><div className="text-[11px] text-[var(--muted)] truncate">{f.path}</div></div>{tab === 'chg' && <span className="font-mono text-[11px] shrink-0"><span className="text-emerald-500">+{f.add}</span> <span className="text-rose-500">−{f.del}</span></span>}<Icon n="chevron" s={13} className="text-[var(--muted)]" /></button>) : <div className="h-full grid place-items-center text-center px-6"><div><div className="mx-auto size-14 rounded-2xl bg-[var(--sunken)] grid place-items-center text-[var(--muted)] mb-3"><Icon n={tab === 'out' ? 'spark' : 'file'} s={22} /></div><div className="font-medium">{tab === 'out' ? '还没有产物' : '还没有变更'}</div><div className="text-[12px] text-[var(--muted)] mt-1">任务生成的文件会出现在这里</div></div></div>
        })()}
    </div>
  </aside>
}
