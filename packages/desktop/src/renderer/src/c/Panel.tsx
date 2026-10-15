import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from './icons'
import { FileIcon, type FileItem } from './Task'
import { cx, IconBtn, Btn } from './ui'
import { errorText, store, type Session, type ContextReference } from '../bridge'
import Md from './Markdown'
import Review from './Review'
import { closePreview, emptyPreview, openPreview, type PreviewMemory, type PreviewState } from './preview-state'

export default function Panel({ files, sel, setSel, onClose, session, onError, memory, onReference }: { files: FileItem[]; sel: FileItem | null; setSel: (file: FileItem | null) => void; onClose: () => void; session: Session; onError: (message: string) => void; memory: PreviewMemory; onReference: (ref: ContextReference) => void }) {
  const id = session.meta.id
  const [view, setView] = useState(() => memory.get(id) ?? emptyPreview())
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>(), [source, setSource] = useState(false), [selection, setSelection] = useState<{ start: number; end: number }>()
  const mounted = useRef(true), viewport = useRef<HTMLDivElement>(null), request = useRef(0)
  const change = (fn: (value: PreviewState) => PreviewState) => setView(previous => { const next = fn({ ...previous, scroll: memory.get(id)?.scroll ?? previous.scroll }); memory.set(id, next); return next })
  const active = view.tabs.find(tab => tab.path === view.active)
  const preview = active ? view.previews[active.path] : undefined
  const showDiff = active ? view.diff[active.path] : false
  const version = (path: string) => { const file = files.find(f => f.path.replace(/\\/g, '/') === path.replace(/\\/g, '/')); return JSON.stringify(file ? [file.kind, file.diff, file.add, file.del] : null) }
  const stale = active && preview && view.versions[active.path] !== version(active.path)
  const scrollKey = (active?.path ?? '') + ':' + (showDiff ? 'diff' : 'content')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (sel) { change(value => openPreview(value, sel)); setSel(null) } }, [sel])
  const load = async (file: FileItem) => {
    const token = ++request.current; setLoading(true); setError(undefined)
    try {
      const result = await store.api!.file(id, file.path, 'read')
      if (mounted.current && token === request.current) change(value => value.tabs.some(tab => tab.path === file.path) ? { ...value, previews: { ...value.previews, [file.path]: result }, versions: { ...value.versions, [file.path]: version(file.path) } } : value)
    } catch (e) { if (mounted.current && token === request.current) setError(errorText(e)) }
    finally { if (mounted.current && token === request.current) setLoading(false) }
  }
  useEffect(() => { setSource(false); setSelection(undefined); setError(undefined); if (active && active.kind !== 'del' && !preview) void load(active); else { request.current++; setLoading(false) } }, [active?.path])
  useLayoutEffect(() => { if (viewport.current) viewport.current.scrollTop = memory.get(id)?.scroll[scrollKey] ?? 0 }, [scrollKey, !!preview, source])
  const open = (file: FileItem) => change(value => openPreview(value, file))
  const tabs = [['out', '产物'], ['chg', '变更'], ['prog', '进度']] as const
  const reference = () => {
    if (!active || !preview?.digest || !selection) return
    const startLine = preview.text.slice(0, selection.start).split('\n').length
    onReference({ path: active.path, start: selection.start, end: selection.end, digest: preview.digest, label: active.name + ':L' + startLine })
    setSelection(undefined)
  }
  const reveal = async () => { if (active) try { await store.api!.file(id, active.path, 'reveal') } catch (e) { onError(errorText(e)) } }
  const restored = () => { change(value => ({ ...value, previews: {} })); if (active && active.kind !== 'del') void load(active) }
  return <aside data-testid="artifact-panel" className={cx('detail-panel shrink-0 border-l border-[var(--line)] bg-[var(--surface-solid)] flex flex-col min-h-0 min-w-0', active ? 'w-[380px]' : 'w-[320px]')}>
    <div className="h-11 flex items-center gap-1 px-2 border-b border-[var(--line)] shrink-0"><div className="flex p-0.5 rounded-lg bg-[var(--sunken)]">{tabs.map(([key, label]) => <button key={key} onClick={() => change(value => ({ ...value, section: key, active: null }))} className={cx('h-7 px-3 rounded-md text-[12px] transition', view.section === key && !active ? 'bg-[var(--surface-solid)] shadow-sm font-medium' : 'text-[var(--muted)]')}>{label}</button>)}</div><span className="flex-1" /><IconBtn n="x" label="收起面板" onClick={onClose} /></div>
    {!!view.tabs.length && <div role="tablist" aria-label="文件预览标签" className="flex overflow-x-auto shrink-0 border-b border-[var(--line)] p-1 gap-1">{view.tabs.map(file => <div key={file.path} className={cx('shrink-0 max-w-48 flex items-center rounded-lg border', file.path === view.active ? 'border-accent/25 bg-[var(--accent-soft)] text-accent' : 'border-transparent text-[var(--muted)]')}><button role="tab" aria-selected={file.path === view.active} title={file.path} onClick={() => change(value => ({ ...value, active: file.path }))} className="min-w-0 flex items-center gap-1.5 pl-2 pr-1 py-1.5 text-[11px]"><Icon n="file" s={12} /><span className="truncate">{file.name}</span></button><button aria-label={'关闭文件 ' + file.name} onClick={() => change(value => closePreview(value, file.path))} className="p-1 mr-0.5 rounded hover:bg-[var(--hover)]"><Icon n="x" s={11} /></button></div>)}</div>}
    {active ? <div data-testid="file-preview" className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1 px-2 py-2 border-b border-[var(--line)] shrink-0"><IconBtn n="chevron" label="返回产物列表" onClick={() => change(value => ({ ...value, active: null }))} className="rotate-180" /><span title={active.path} className="flex-1 min-w-0 truncate text-[11px] text-[var(--muted)]">{active.path}</span><IconBtn n="copy" label="复制文件路径" onClick={() => { void navigator.clipboard.writeText(active.path).catch(e => onError(errorText(e))) }} /><IconBtn n="refresh" label="刷新文件" onClick={() => { setSelection(undefined); void load(active) }} /><IconBtn n="folder" label="在资源管理器中显示" onClick={() => void reveal()} /></div>
      <div className="flex items-center flex-wrap gap-1 p-2 border-b border-[var(--line)] shrink-0">{active.diff && <Btn v={showDiff ? 'soft' : 'ghost'} onClick={() => { change(value => ({ ...value, diff: { ...value.diff, [active.path]: true } })); setSource(false); setSelection(undefined) }}>变更 diff</Btn>}{active.kind !== 'del' && <Btn v={!showDiff && !source ? 'soft' : 'ghost'} onClick={() => { change(value => ({ ...value, diff: { ...value.diff, [active.path]: false } })); setSource(false); setSelection(undefined) }}>文件内容</Btn>}{!showDiff && preview && !preview.binary && <Btn v={source ? 'soft' : 'ghost'} onClick={() => { setSource(!source); setSelection(undefined) }}>选择文本</Btn>}</div>
      {stale && <div role="status" className="px-3 py-2 text-[11px] bg-[var(--accent-soft)] text-accent">文件有新的变更。当前保留阅读位置，可点击刷新查看最新内容。</div>}
      {source && <div className="px-3 py-2 text-[11px] text-[var(--muted)] border-b border-[var(--line)] flex items-center gap-2"><span className="flex-1">选中文本后加入当前对话。</span><Btn v="primary" disabled={!selection || selection.start === selection.end} onClick={reference}>引用选区并修改</Btn></div>}
      <div ref={viewport} className="flex-1 overflow-auto min-h-0" onScroll={e => { const current = memory.get(id) ?? view; memory.set(id, { ...current, scroll: { ...current.scroll, [scrollKey]: e.currentTarget.scrollTop } }) }}>
        {showDiff && active.diff ? <div className="font-mono text-[11.5px] leading-[1.8] py-2">{active.diff.split('\n').map((line, i) => <div key={i} className={cx('flex px-2', line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', line.startsWith('-') && !line.startsWith('---') && 'bg-rose-500/10 text-rose-600 dark:text-rose-300')}><span className="w-8 shrink-0 text-right pr-2 text-[var(--muted)]/60 select-none">{i + 1}</span><span className="whitespace-pre">{line || ' '}</span></div>)}</div>
          : active.kind === 'del' ? <div className="p-5 text-[var(--muted)]">文件已删除，可在变更审查中查看或恢复。</div>
          : loading ? <div className="p-5 text-[var(--muted)]">正在读取文件…</div>
          : error ? <div role="alert" className="p-5 text-rose-500 break-words">{error}</div>
          : preview?.binary ? <div className="p-6 text-center"><FileIcon name={active.name} s={48} /><p className="my-4 text-[var(--muted)]">{preview.reason ?? '此格式请使用本机应用查看。'}</p><Btn v="outline" onClick={() => void reveal()}>在资源管理器中显示</Btn></div>
          : preview ? source ? <textarea aria-label="文件文本选区" readOnly value={preview.text} onSelect={e => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })} className="block w-full min-h-full resize-none bg-transparent p-4 font-mono text-[12px] outline-none leading-relaxed" style={{ height: Math.max(320, preview.text.split('\n').length * 20 + 40) }} /> : /\.md$/i.test(active.name) ? <div className="p-5"><Md text={preview.text} /></div> : <pre className="p-4 font-mono text-[12px] whitespace-pre-wrap break-all">{preview.text || '空文件'}</pre> : null}
      </div>
    </div> : <div data-testid="artifact-list" className="flex-1 overflow-auto p-2 min-h-0">
      {view.section === 'chg' ? <Review key={id} session={session} onOpenFile={open} onRestored={restored} onError={onError} /> : view.section === 'prog' ? <div className="p-3 space-y-4">{[['最近一轮用时', session.summaries.at(-1) ? (session.summaries.at(-1)!.durationMs / 1000).toFixed(1) + ' 秒' : '—'], ['累计 Token', session.usage ? (session.usage.totalInputTokens + session.usage.totalOutputTokens).toLocaleString() : '—'], ['文件变更', files.length + ' 个']].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-[var(--muted)]">{label}</span><span className="tabular-nums">{value}</span></div>)}</div> : files.filter(f => f.kind !== 'del').length ? files.filter(f => f.kind !== 'del').map(file => <button key={file.path} onClick={() => open(file)} className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--hover)] text-left"><FileIcon name={file.name} s={30} /><div className="flex-1 min-w-0"><div className="font-medium truncate">{file.name}</div><div className="text-[11px] text-[var(--muted)] truncate">{file.path}</div></div><Icon n="chevron" s={13} /></button>) : <div className="py-16 text-center text-[var(--muted)]"><Icon n="spark" s={26} className="mx-auto mb-3 opacity-50" />任务生成的文件会出现在这里</div>}
    </div>}
  </aside>
}
