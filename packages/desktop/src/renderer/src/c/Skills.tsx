import { useEffect, useRef, useState } from 'react'
import { errorText, store, type Skill, type SkillPreview } from '../bridge'
import { Modal } from './Overlays'
import { Btn, cx } from './ui'
import Icon from './icons'

export default function Skills({ onError }: { onError: (message: string) => void }) {
  const [skills, setSkills] = useState<Skill[]>([]), [query, setQuery] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState('')
  const [importing, setImporting] = useState<'url' | 'text'>(), [url, setUrl] = useState(''), [text, setText] = useState(''), [error, setError] = useState<string>()
  const [preview, setPreview] = useState<SkillPreview>(), [detail, setDetail] = useState<Skill & { text: string }>(), [deleting, setDeleting] = useState<Skill>()
  const inspection = useRef(0)
  const refresh = async () => setSkills(await store.api!.skills<Skill[]>('list'))
  useEffect(() => { let alive = true; void store.api!.skills<Skill[]>('list').then(value => { if (alive) setSkills(value) }).catch(e => { if (alive) setError(errorText(e)) }).finally(() => { if (alive) setLoading(false) }); return () => { alive = false; ++inspection.current } }, [])
  const inspect = async (action: string, value?: unknown) => {
    const request = ++inspection.current
    setBusy('import'); setError(undefined)
    try { const result = await store.api!.skills<SkillPreview | null>(action, value); if (result && request === inspection.current) { setPreview(result); setImporting(undefined) } }
    catch (e) { if (request === inspection.current) setError(errorText(e)) } finally { if (request === inspection.current) setBusy('') }
  }
  const cancelInspection = () => { ++inspection.current; setBusy(''); setImporting(undefined); setError(undefined) }
  const readDetail = async (id: string) => {
    const request = ++inspection.current
    try { const value = await store.api!.skills<Skill & { text: string }>('read', { id }); if (request === inspection.current) setDetail(value) }
    catch (e) { if (request === inspection.current) onError(errorText(e)) }
  }
  const configure = async (skill: Skill) => {
    setBusy(skill.id)
    try { await store.api!.skills('configure', { id: skill.id, enabled: !skill.enabled }); await refresh() }
    catch (e) { onError(errorText(e)) } finally { setBusy('') }
  }
  const confirm = async () => {
    if (!preview) return; setBusy('confirm'); setError(undefined)
    try { await store.api!.skills('confirm', { token: preview.token }); await refresh(); setPreview(undefined); onError('技能已导入并保持停用，检查后可手动启用。') }
    catch (e) { setError(errorText(e)) } finally { setBusy('') }
  }
  return <div data-testid="skills-page" className="flex-1 overflow-y-auto p-6 lg:p-10"><div className="max-w-5xl mx-auto">
    <div className="flex items-start justify-between gap-4 flex-wrap"><div><h1 className="text-[25px] font-semibold">技能</h1><p className="mt-2 text-[var(--muted)]">把常用工作方法留在这里，在需要时加入任务。</p></div><div className="flex items-center gap-2 flex-wrap"><Btn v="outline" disabled={!!busy} onClick={() => { setError(undefined); void inspect('preview-file') }}><Icon n="file" s={14} />从文件导入</Btn><Btn v="outline" disabled={!!busy} onClick={() => { setError(undefined); setImporting('text') }}>粘贴内容</Btn><Btn v="primary" disabled={!!busy} onClick={() => { setError(undefined); setImporting('url') }}><Icon n="plus" s={14} />从链接导入</Btn></div></div>
    <div className="mt-6 flex items-center gap-3"><div className="flex-1 max-w-md relative"><Icon n="search" s={15} className="absolute left-3 top-2.5 text-[var(--muted)]" /><input aria-label="搜索技能" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称或用途" className="field w-full pl-9" /></div><span className="text-[12px] text-[var(--muted)]">{skills.filter(skill => skill.enabled).length} 项已启用</span></div>
    {error && !importing && !preview && <div role="alert" className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3 text-rose-500 break-words">{error}<Btn v="ghost" onClick={() => { setLoading(true); setError(undefined); void refresh().catch(e => setError(errorText(e))).finally(() => setLoading(false)) }}>重试</Btn></div>}
    {loading ? <div role="status" className="py-20 text-center text-[var(--muted)]">正在读取技能…</div> : <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-3">{skills.filter(skill => (skill.name + skill.description).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(skill => <article key={skill.id} data-testid="skill-card" className="rounded-2xl p-5 border border-[var(--line)] bg-[var(--surface-solid)]"><div className="flex gap-3 items-start"><div className="size-10 rounded-xl bg-[var(--accent-soft)] text-accent shrink-0 grid place-items-center"><Icon n="spark" s={20} /></div><div className="min-w-0 flex-1"><button onClick={() => void readDetail(skill.id)} className="font-medium text-[15px] text-left hover:text-accent break-words">{skill.name}</button><div className="mt-1 flex items-center gap-2 text-[10.5px] text-[var(--muted)]"><span>{skill.source === 'builtin' ? '内置' : skill.source === 'url' ? '网络导入' : skill.source === 'file' ? '文件导入' : '手动添加'}</span><span>·</span><span>{skill.enabled ? '已启用' : '已停用'}</span></div></div><button role="switch" aria-label={'启用技能 ' + skill.name} aria-checked={skill.enabled} disabled={!!busy} onClick={() => void configure(skill)} className={cx('w-9 h-5 rounded-full p-0.5 shrink-0 transition disabled:opacity-50', skill.enabled ? 'bg-accent' : 'bg-[var(--line)]')}><span className={cx('block size-4 rounded-full bg-white shadow-sm transition-transform', skill.enabled && 'translate-x-4')} /></button></div><p className="mt-4 text-[12px] leading-relaxed text-[var(--muted)] break-words line-clamp-3">{skill.description}</p><div className="flex justify-between gap-2 mt-4 text-[11px] text-[var(--muted)]"><span className="truncate" title={skill.origin}>{skill.origin}</span>{skill.source !== 'builtin' && <button aria-label={'删除技能 ' + skill.name} onClick={() => setDeleting(skill)} className="hover:text-rose-500 shrink-0">删除</button>}</div></article>)}</div>}
    {!loading && !skills.some(skill => (skill.name + skill.description).toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <div className="py-16 text-center text-[var(--muted)]">没有匹配的技能。</div>}
    <p className="mt-6 text-[12px] text-[var(--muted)] leading-relaxed">启用后，可在输入框的技能菜单中选择。本版导入 SKILL.md 工作说明；不会自动安装配套脚本，也不会授予额外操作权限。</p>
  </div>
  {importing && <Modal label={importing === 'url' ? '从链接导入技能' : '粘贴技能内容'} onClose={cancelInspection} w="w-[620px]"><form className="p-6" onSubmit={e => { e.preventDefault(); void inspect(importing === 'url' ? 'preview-url' : 'preview-text', importing === 'url' ? { url } : { text }) }}><h2 className="text-[18px] font-semibold">{importing === 'url' ? '从链接导入技能' : '粘贴 SKILL.md 内容'}</h2><p className="mt-2 text-[12px] text-[var(--muted)] leading-relaxed">先读取并预览，再由你确认导入。支持公开 HTTPS 原始文件及 GitHub 的 SKILL.md 文件链接。</p>{importing === 'url' ? <input autoFocus aria-label="技能链接" type="url" required value={url} onChange={e => setUrl(e.target.value)} maxLength={4096} placeholder="https://github.com/…/SKILL.md" className="field w-full mt-5" /> : <textarea autoFocus aria-label="技能内容" required value={text} onChange={e => setText(e.target.value)} maxLength={65536} placeholder={'---\nname: 我的技能\ndescription: 适用任务\n---\n工作步骤…'} className="field w-full mt-5 h-64 font-mono text-[12px] resize-y" />}{error && <p role="alert" className="mt-3 text-rose-500 break-words">{error}</p>}<div className="mt-5 flex justify-end gap-2"><Btn type="button" onClick={cancelInspection}>取消</Btn><Btn type="submit" v="primary" disabled={!!busy}>{busy ? '正在读取…' : '读取并预览'}</Btn></div></form></Modal>}
  {(preview || detail) && <Modal label="技能内容预览" onClose={() => { if (!busy) { ++inspection.current; setPreview(undefined); setDetail(undefined); setError(undefined) } }} w="w-[740px]"><div className="p-6 flex flex-col max-h-[85vh]"><h2 className="text-[18px] font-semibold break-words">{(preview ?? detail)!.name}</h2><p className="mt-1 text-[12px] text-[var(--muted)] break-all">来源：{(preview ?? detail)!.origin}</p>{(preview ?? detail)!.warnings.map(warning => <p key={warning} className="mt-2 text-[12px] text-amber-600 dark:text-amber-400">{warning}</p>)}<pre className="mt-4 p-4 rounded-xl bg-[var(--sunken)] border border-[var(--line)] overflow-auto min-h-0 flex-1 text-[12px] whitespace-pre-wrap break-words font-mono">{(preview ?? detail)!.text}</pre>{error && <p role="alert" className="mt-3 text-rose-500">{error}</p>}<div className="mt-4 flex justify-end gap-2"><Btn disabled={!!busy} onClick={() => { ++inspection.current; setPreview(undefined); setDetail(undefined) }}>{preview ? '取消' : '关闭'}</Btn>{preview && <Btn v="primary" disabled={!!busy} onClick={() => void confirm()}>{busy ? '正在导入…' : '确认导入，保持停用'}</Btn>}</div></div></Modal>}
  {deleting && <Modal label="删除技能" onClose={() => setDeleting(undefined)} w="w-[420px]"><div className="p-6"><h2 className="font-semibold text-[18px]">删除“{deleting.name}”？</h2><p className="mt-3 text-[var(--muted)]">已有对话的记录会保留，此技能将不再可供新任务选择。</p><div className="mt-5 flex justify-end gap-2"><Btn disabled={!!busy} onClick={() => setDeleting(undefined)}>取消</Btn><Btn v="danger" disabled={!!busy} onClick={() => { setBusy('delete'); void store.api!.skills('remove', { id: deleting.id }).then(refresh).then(() => setDeleting(undefined)).catch(e => onError(errorText(e))).finally(() => setBusy('')) }}>确认删除</Btn></div></div></Modal>}
  </div>
}
