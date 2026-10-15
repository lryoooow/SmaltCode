import { useEffect, useState } from 'react'
import { errorText, store, type Checkpoint, type Session } from '../bridge'
import type { FileItem } from './Task'
import { Btn } from './ui'
import Icon from './icons'
import { Modal } from './Overlays'

export default function Review({ session, onOpenFile, onRestored, onError }: { session: Session; onOpenFile: (file: FileItem) => void; onRestored: () => void; onError: (message: string) => void }) {
  const [records, setRecords] = useState<Checkpoint[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string>(), [confirm, setConfirm] = useState<{ record: Checkpoint; paths: string[] }>(), [restoring, setRestoring] = useState(false)
  const busy = store.busy(session.meta.id)
  const load = async () => {
    setLoading(true); setError(undefined)
    try { const result = await store.api!.call<{ checkpoints: Checkpoint[] }>('checkpoint/list', { threadId: session.meta.id }); setRecords(result.checkpoints) }
    catch (e) { setError(errorText(e)) } finally { setLoading(false) }
  }
  useEffect(() => { if (!busy) void load(); else setLoading(false) }, [session.meta.id, busy, session.meta.updatedAt])
  const inspect = async (record: Checkpoint, path: string) => {
    try {
      const result = await store.api!.call<{ checkpoints: Checkpoint[] }>('checkpoint/list', { threadId: session.meta.id, checkpointId: record.id })
      const file = result.checkpoints[0]?.files.find(f => f.path === path)
      if (!file) throw new Error('检查点文件不存在')
      onOpenFile({ path, name: path.split('/').pop()!, kind: file.kind === 'add' ? 'new' : file.kind === 'delete' ? 'del' : 'mod', diff: file.diff, add: file.diff?.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length ?? 0, del: file.diff?.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length ?? 0 })
    } catch (e) { onError(errorText(e)) }
  }
  const restore = async () => {
    if (!confirm || restoring) return
    setRestoring(true)
    try { await store.api!.call('checkpoint/restore', { threadId: session.meta.id, checkpointId: confirm.record.id, paths: confirm.paths }); setConfirm(undefined); onRestored(); await load() }
    catch (e) { onError(errorText(e)); await load() } finally { setRestoring(false) }
  }
  return <div data-testid="checkpoint-review" className="space-y-3 p-1">
    <div className="flex items-center justify-between"><span className="font-medium">变更审查</span><Btn v="ghost" disabled={loading} onClick={() => void load()}><Icon n="refresh" s={12} />刷新</Btn></div>
    <p className="text-[11px] text-[var(--muted)] leading-relaxed">按操作保存修改前后的文件。恢复只影响所选文件，保留对话记录；终端命令产生的外部改动不在恢复范围内。</p>
    {busy && <p className="text-[11px] rounded-lg p-2 bg-[var(--accent-soft)] text-accent">运行中可以审阅；恢复文件前请先停止此工作区的任务。</p>}
    {loading && <p className="text-[var(--muted)] p-3">正在核对检查点…</p>}{error && <p role="alert" className="text-rose-500 break-words">{error}</p>}
    {!loading && !error && !records.length && <p className="py-8 text-center text-[var(--muted)]">新产生的文件修改会自动记录检查点。</p>}
    {records.map(record => <div key={record.id} data-testid="checkpoint-row" className="rounded-xl border border-[var(--line)] p-3 bg-[var(--surface-solid)]"><div className="flex items-start gap-2"><Icon n="clock" s={14} className="text-accent mt-0.5" /><div className="min-w-0 flex-1"><div className="text-[12px] font-medium break-words">{record.title.replace(/^(?:write|update|apply_patch)\b/, record.files.every(file => file.kind === 'add') ? '新建文件' : '修改文件').replace(/^create\b/, '新建文件').replace(/^delete\b/, '删除文件')}</div><div className="text-[10.5px] text-[var(--muted)] mt-1">{new Date(record.createdAt).toLocaleString('zh-CN')} · {record.files.length} 个文件</div></div></div><div className="mt-2 space-y-2">{record.files.map(file => <div key={file.path} className="rounded-lg bg-[var(--sunken)] p-2"><button title={file.path} onClick={() => void inspect(record, file.path)} className="block w-full text-left text-[12px] text-accent truncate">{file.path}</button><div className="flex items-center justify-between gap-2 mt-1"><span className="text-[10.5px] text-[var(--muted)]">{file.restored ? '已恢复' : file.kind === 'add' ? '新建' : file.kind === 'delete' ? '删除' : '修改'}</span><button disabled={busy || restoring || file.restored || !!file.conflict || !record.complete} onClick={() => setConfirm({ record, paths: [file.path] })} className="text-[11px] text-[var(--muted)] hover:text-accent disabled:opacity-40">撤销此文件</button></div>{file.conflict && !file.restored && <p className="text-[10.5px] text-amber-600 dark:text-amber-400 mt-1 leading-relaxed">{file.conflict}</p>}</div>)}</div><Btn className="mt-2 w-full" v="outline" disabled={busy || restoring || !record.complete || record.files.every(f => f.restored) || record.files.some(f => !f.restored && f.conflict)} onClick={() => setConfirm({ record, paths: record.files.filter(f => !f.restored).map(f => f.path) })}>恢复这次修改前的文件</Btn></div>)}
    {confirm && <Modal label="恢复检查点" onClose={() => { if (!restoring) setConfirm(undefined) }} w="w-[460px]"><div className="p-6"><h2 className="text-[18px] font-semibold">恢复所选文件？</h2><p className="text-[var(--muted)] mt-3 text-[12px]">将恢复到这次操作前的内容，新建文件将移除。恢复前再次核对，存在后续修改时不会覆盖。</p><ul className="mt-3 max-h-48 overflow-auto text-[12px] space-y-1">{confirm.paths.map(path => <li key={path} className="break-all">{path}</li>)}</ul><div className="mt-5 flex justify-end gap-2"><Btn disabled={restoring} onClick={() => setConfirm(undefined)}>取消</Btn><Btn v="primary" disabled={restoring} onClick={() => void restore()}>{restoring ? '正在恢复…' : '确认恢复文件'}</Btn></div></div></Modal>}
  </div>
}
