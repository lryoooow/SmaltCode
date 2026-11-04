import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { errorText, store, type Checkpoint, type RestorePreviewRow, type RestoreReceipt, type Session } from '../bridge'
import type { FileItem } from './Task'
import { Btn } from './ui'

const previewLabels = { ready: '将恢复', conflict: '有冲突', missing: '无恢复记录', restored: '已恢复' }
const resultLabels = { restored: '已恢复', conflict: '冲突 · 已保留', failed: '恢复失败', skipped: '已跳过' }
const recordTitle = (record: Checkpoint) => record.title
  .replace(/^(?:write|update|apply_patch)\b/, record.files.every(file => file.kind === 'add') ? '新建文件' : '修改文件')
  .replace(/^create\b/, '新建文件').replace(/^delete\b/, '删除文件')

export default function Review({ session, onOpenFile, onRestored, onError }: { session: Session; onOpenFile: (file: FileItem) => void; onRestored: () => void; onError: (message: string) => void }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  const threadId = session.meta.id
  const run = store.checkpointRun(threadId)
  const busy = store.busy(threadId)
  const [records, setRecords] = useState<Checkpoint[]>([])
  const [savedReceipt, setSavedReceipt] = useState<RestoreReceipt>()
  const receipt = savedReceipt && (!run?.result || savedReceipt.at > run.result.at) ? savedReceipt : run?.result
  const receiptRecord = records.find(record => record.id === receipt?.checkpointId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<{ record: Checkpoint; paths?: string[]; rows: RestorePreviewRow[] }>()
  const [checking, setChecking] = useState(false)
  const [detail, setDetail] = useState<RestorePreviewRow>()
  const [loadingDiff, setLoadingDiff] = useState<string>()
  const request = useRef(0), alive = useRef(true), listRequest = useRef(0)

  const load = async () => {
    const token = ++listRequest.current
    setLoading(true); setError(undefined)
    try {
      const result = await store.api!.call<{ checkpoints: Checkpoint[]; latestRestore?: RestoreReceipt }>('checkpoint/list', { threadId, receipt: true })
      if (alive.current && token === listRequest.current) {
        setRecords(result.checkpoints)
        setSavedReceipt(result.latestRestore)
      }
    } catch (e) { if (alive.current && token === listRequest.current) setError(errorText(e)) }
    finally { if (alive.current && token === listRequest.current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++request.current; ++listRequest.current } }, [threadId])
  useEffect(() => { void load() }, [threadId, busy, session.meta.updatedAt, run?.pending])

  const inspect = async (record: Checkpoint, path: string) => {
    try {
      const result = await store.api!.call<{ checkpoints: Checkpoint[] }>('checkpoint/list', { threadId, checkpointId: record.id })
      if (!alive.current) return
      const file = result.checkpoints[0]?.files.find(f => f.path === path)
      if (!file) throw new Error('检查点文件不存在')
      onOpenFile({ path, name: path.split('/').pop()!, kind: file.kind === 'add' ? 'new' : file.kind === 'delete' ? 'del' : 'mod', diff: file.diff, add: file.diff?.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length ?? 0, del: file.diff?.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length ?? 0 })
    } catch (e) { if (alive.current) onError(errorText(e)) }
  }
  const inspectRestore = async (record: Checkpoint, paths?: string[]) => {
    const token = ++request.current
    setChecking(true); setPreview({ record, paths, rows: [] }); setDetail(undefined); setLoadingDiff(undefined); setError(undefined)
    try {
      const result = await store.api!.call<{ rows: RestorePreviewRow[] }>('checkpoint/list', { threadId, checkpointId: record.id, preview: true, paths })
      if (alive.current && token === request.current) setPreview({ record, paths, rows: result.rows })
    } catch (e) { if (alive.current && token === request.current) setError(errorText(e)) }
    finally { if (alive.current && token === request.current) setChecking(false) }
  }
  const openDiff = async (row: RestorePreviewRow) => {
    if (!preview) return
    const token = ++request.current
    setDetail(undefined); setLoadingDiff(row.path)
    try {
      const result = await store.api!.call<{ rows: RestorePreviewRow[] }>('checkpoint/list', { threadId, checkpointId: preview.record.id, preview: true, diffPath: row.path })
      if (!alive.current || token !== request.current) return
      const current = result.rows[0]
      if (!current) throw new Error('文件差异已不可用')
      setDetail(current)
      if (row.status === 'ready' && (current.status !== 'ready' || current.version !== row.version)) {
        setPreview({ ...preview, rows: preview.rows.map(value => value.path === row.path ? { path: row.path, status: 'conflict', reason: '文件状态已变化，请重新核对' } : value) })
      }
    } catch (e) { if (alive.current && token === request.current) setDetail({ ...row, diffNote: errorText(e) }) }
    finally { if (alive.current && token === request.current) setLoadingDiff(undefined) }
  }
  const restore = async () => {
    if (!preview || busy || run?.pending) return
    const selected = preview
    setPreview(undefined)
    const result = await store.restoreCheckpoint(threadId, selected.record.id, selected.rows, selected.paths ?? null)
    if (alive.current && result?.restored.length) onRestored()
  }
  const ready = preview?.rows.filter(row => row.status === 'ready').length ?? 0
  const unrecorded = !records.length && !loading && !error ? [...new Set(session.items.flatMap(item => item.kind === 'fileChange' ? [item.path] : []))] : []

  return <div data-testid="checkpoint-review" className="space-y-3 p-1">
    <div className="flex items-center justify-between"><span className="font-medium">变更审查</span><Btn disabled={loading} onClick={() => void load()}>刷新</Btn></div>
    <p className="text-[11px] text-[var(--muted)]">按操作记录修改前后的文件。终端产生但未记录的变更范围未知，恢复范围以快照为准。</p>
    {busy && <p className="text-[11px] text-accent">运行中可以预览。请先停止同一工作区的任务，再确认恢复。</p>}
    {loading && <p role="status" className="text-[12px] text-[var(--muted)]">正在核对检查点…</p>}
    {error && <p role="alert" className="text-rose-500 break-words">{error}</p>}
    {run?.pending && <p role="status" className="text-[12px] text-accent">正在逐项恢复文件…</p>}
    {run?.error && <p role="alert" className="text-[12px] text-rose-500 break-words">{run.error}</p>}
    {receipt && <section data-testid="checkpoint-results" className="rounded-xl border border-[var(--line)] p-3 text-[12px] space-y-2" aria-label="恢复结果">
      <h3 className="font-medium">恢复结果 · {receipt.restored.length} 个文件已恢复</h3>
      <p className="text-[var(--muted)]">{new Date(receipt.at).toLocaleString('zh-CN')}{receiptRecord ? ' · ' + recordTitle(receiptRecord) : ''}</p>
      {receipt.notice && <p role="alert">{receipt.notice}</p>}
      <ul className="space-y-2">{receipt.rows.map(row => <li key={row.path} className="break-all"><strong>{resultLabels[row.status]}</strong> · {row.path}<p className="text-[var(--muted)]">{row.reason}</p></li>)}</ul>
    </section>}
    {!loading && !error && !records.length && <p className="text-[12px] text-[var(--muted)]">当前对话暂无可用检查点。</p>}
    {!!unrecorded.length && <details className="text-[12px]"><summary className="cursor-pointer">已知变更中无恢复记录 · {unrecorded.length} 项</summary><ul className="space-y-1">{unrecorded.map(path => <li key={path} className="break-all">{path}</li>)}</ul></details>}
    {records.map(record => <article key={record.id} data-testid="checkpoint-row" className="rounded-xl border border-[var(--line)] p-3 bg-[var(--surface-solid)]">
      <h3 className="text-[12px] font-medium break-words">{recordTitle(record)}</h3>
      <p className="text-[11px] text-[var(--muted)]">{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.files.length} 个文件</p>
      <ul className="mt-2 space-y-2">{record.files.map(file => <li key={file.path} className="rounded-lg bg-[var(--sunken)] p-2 text-[12px]">
        <button title={file.path} onClick={() => void inspect(record, file.path)} className="block w-full text-left text-accent truncate">{file.path}</button>
        <div className="flex items-center justify-between gap-2 mt-1"><span className="text-[var(--muted)]">{file.restored ? '已恢复' : file.kind === 'add' ? '新建' : file.kind === 'delete' ? '删除' : '修改'}</span><button onClick={() => void inspectRestore(record, [file.path])} className="hover:underline">{file.restored || file.conflict ? '查看恢复预览' : '撤销此文件'}</button></div>
        {file.conflict && !file.restored && <p className="text-amber-700 dark:text-amber-300 mt-1">{file.conflict}</p>}
      </li>)}</ul>
      <Btn className="mt-2 w-full" v="outline" onClick={() => void inspectRestore(record)}>预览本次恢复</Btn>
      {preview?.record.id === record.id && <section data-testid="checkpoint-restore-preview" aria-label="恢复前预览" className="mt-3 border-t border-[var(--line)] pt-3 space-y-2 text-[12px]">
        <h4 className="font-medium">恢复前预览</h4>
        {checking && <p role="status">正在核对当前文件…</p>}
        <ul className="space-y-2">{preview.rows.map(row => <li key={row.path} className="rounded-lg border border-[var(--line)] p-2 [overflow-wrap:anywhere]">
          <strong>{previewLabels[row.status]}</strong> · {row.path}
          <p className="text-[var(--muted)]">{row.reason}</p>
          {(row.status === 'ready' || row.status === 'conflict') && <button type="button" className="text-accent hover:underline" disabled={loadingDiff === row.path} onClick={() => detail?.path === row.path ? setDetail(undefined) : void openDiff(row)}>{loadingDiff === row.path ? '正在读取差异…' : detail?.path === row.path ? '收起差异' : '查看恢复差异'}</button>}
          {detail?.path === row.path && <div className="mt-2 space-y-1"><p className="text-[var(--muted)]">当前文件 → 检查点保存的恢复目标</p>{detail.diffNote && <p>{detail.diffNote}</p>}{detail.diff && <pre aria-label="恢复差异" tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] bg-[var(--sunken)] p-2">{detail.diff}</pre>}</div>}
        </li>)}</ul>
        <div className="flex flex-wrap justify-end gap-1">
          <Btn onClick={() => { ++request.current; setPreview(undefined); setDetail(undefined); setLoadingDiff(undefined); setChecking(false) }}>关闭预览</Btn>
          <Btn disabled={checking} onClick={() => void inspectRestore(record, preview.paths)}>重新核对</Btn>
          <Btn v="primary" disabled={!ready || checking || !!loadingDiff || busy || run?.pending} onClick={() => void restore()}>确认恢复文件{ready ? `（${ready} 项）` : ''}</Btn>
        </div>
      </section>}
    </article>)}
  </div>
}
