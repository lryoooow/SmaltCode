import { useEffect, useRef, useState } from 'react'
import { store, errorText, type ContextReference } from '../bridge'
import type { BrowserState } from '../../../shared/browser'
import { Btn, IconBtn, cx } from './ui'
import Popover from './Popover'

export default function Browser({ threadId, cwd, activeId, onActive, onReference }: { threadId: string; cwd: string; activeId?: string; onActive: (id?: string) => void; onReference: (ref: ContextReference) => void }) {
  const [state, setState] = useState<BrowserState>({ tabs: [] }), [url, setURL] = useState(''), [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [picking, setPicking] = useState(false), [local, setLocal] = useState(false), [query, setQuery] = useState('.html'), [files, setFiles] = useState<string[]>([])
  const meta=store.getSnapshot().sessions[threadId]?.meta,localAllowed=!meta?.sshTarget&&!meta?.containerTarget
  const address = useRef<HTMLInputElement>(null), host = useRef<HTMLDivElement>(null), alive = useRef(true), request = useRef(0)
  const [permissions, setPermissions] = useState(false), [sourceURL, setSourceURL] = useState('')
  const permissionAnchor = useRef<HTMLButtonElement>(null)
  const tab = state.tabs.find(value => value.id === activeId) ?? state.tabs[0], id = tab?.id
  const call = <T,>(action: string, value: Record<string, unknown> = {}) => store.api!.browser<T>(action, { threadId, id, ...value })
  const refresh = async () => { const sequence = ++request.current; try { const next = await call<BrowserState>('list'); if (alive.current && sequence === request.current) setState(next) } catch (error) { if (alive.current) setError(errorText(error)) } }
  useEffect(() => { alive.current = true; void refresh(); const off = store.api?.onBrowser?.(() => void refresh()); return () => { alive.current = false; off?.() } }, [threadId])
  useEffect(() => { if (tab) setURL(tab.localPath ?? tab.url) }, [id, tab?.url])
  useEffect(() => { setPermissions(false); setSourceURL('') }, [id])
  useEffect(() => {
    if (!local) return
    let valid = true
    const timer = setTimeout(() => { void store.api!.searchFiles(cwd, query).then(result => { if (valid) setFiles(result.files.filter(path => /\.html?$/i.test(path))) }).catch(error => { if (valid) setError(errorText(error)) }) }, 180)
    return () => { valid = false; clearTimeout(timer) }
  }, [local, cwd, query])
  useEffect(() => {
    if (!id) return
    let frame = 0, last = '', disposed = false
    const sync = () => {
      frame = 0; if (disposed) return
      const rect = host.current?.getBoundingClientRect(), obscured = document.querySelector('.popover-surface,[role="dialog"],[data-testid="file-mentions"]')
      const bounds = rect && rect.width > 40 && rect.height > 40 && !obscured && !document.hidden ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
      const key = JSON.stringify(bounds); if (key !== last) { last = key; void call('layout', { id, bounds }).catch(() => {}) }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const observer = new ResizeObserver(schedule); if (host.current) observer.observe(host.current)
    const mutation = new MutationObserver(schedule); mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    addEventListener('resize', schedule); addEventListener('scroll', schedule, true); document.addEventListener('visibilitychange', schedule); schedule()
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); mutation.disconnect(); removeEventListener('resize', schedule); removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule); void call('layout', { id }).catch(() => {}); void call('cancel-pick', { id }).catch(() => {}) }
  }, [id,threadId])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || document.querySelector('[role="dialog"]')) return
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); address.current?.focus(); address.current?.select() }
      if (event.key.toLowerCase() === 'w' && id) { event.preventDefault(); void act('close') }
      if (event.key === 'Tab' && state.tabs.length > 1) { event.preventDefault(); const index = state.tabs.findIndex(tab => tab.id === id); onActive(state.tabs[(index + (event.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length].id) }
    }
    addEventListener('keydown', key); return () => removeEventListener('keydown', key)
  }, [id, state.tabs])
  const act = async (action: string, value: Record<string, unknown> = {}) => { setError(undefined); try { await call(action, value); await refresh() } catch (error) { if (alive.current) setError(errorText(error)) } }
  const open = async (value: Record<string, unknown>) => { setBusy(true); setError(undefined); try { const result = await call<{ id: string }>('open', value); if (alive.current) { onActive(result.id); setLocal(false); await refresh() } } catch (error) { if (alive.current) setError(errorText(error)) } finally { if (alive.current) setBusy(false) } }
  const pick = async () => { setPicking(true); setError(undefined); try { const ref = await call<ContextReference | null>('pick'); if (alive.current && ref) onReference(ref) } catch (error) { if (alive.current) setError(errorText(error)) } finally { if (alive.current) setPicking(false) } }
  return <div data-testid="browser-panel" className="flex flex-col flex-1 min-h-0 min-w-0">
    <div role="tablist" aria-label="网页标签" className="flex items-center overflow-x-auto gap-1 px-2 pt-2 shrink-0">{state.tabs.map(value => <div className={cx('panel-file-tab', value.id === id && 'is-active')} key={value.id}><button role="tab" aria-selected={value.id === id} onClick={() => onActive(value.id)} className="px-2 py-2 truncate max-w-40 text-[12px]" title={value.localPath ?? value.url}>{value.loading ? '◌ ' : ''}{value.title}</button><button className="p-1" aria-label={'关闭网页 ' + value.title} onClick={() => void act('close', { id: value.id })}>×</button></div>)}</div>
    <form className="flex flex-wrap items-center gap-1.5 p-2 shrink-0" onSubmit={event => { event.preventDefault(); void (tab && !tab.localPath ? act('navigate', { url }) : open({ url })) }}>
      <IconBtn n="chevron" className="rotate-180" label="网页后退" disabled={!tab?.back} onClick={() => void act('back')} /><IconBtn n="chevron" label="网页前进" disabled={!tab?.forward} onClick={() => void act('forward')} /><IconBtn n={tab?.loading ? 'x' : 'refresh'} label={tab?.loading ? '停止网页加载' : '刷新网页'} disabled={!tab} onClick={() => void act(tab?.loading ? 'stop' : 'reload')} />
      <input ref={address} title={url} aria-label="网页地址" value={url} onChange={event => setURL(event.target.value)} placeholder="https://… 或 http://127.0.0.1:…" className="browser-address flex-1 min-w-32" />
      <Btn type="button" disabled={busy || !url || !!tab?.localPath && url === tab.localPath} onClick={() => void open({ url })}>新标签</Btn><Btn type="button" disabled={busy||!localAllowed} title={localAllowed?undefined:'已绑定远程或容器目标，请通过目标端口预览'} onClick={() => setLocal(!local)}>本地 HTML</Btn>
    </form>
    {tab?.externalSource && <div data-testid="external-source" className="px-3 py-2 text-[11px] text-[var(--muted)] border-t border-[var(--line)] break-all shrink-0"><span className="font-medium text-[var(--text)]">外部内容</span> · {tab.externalSource}<span className="block mt-0.5">独立沙箱 · 无工具调用权限</span></div>}
    {local && <div className="p-3 border-y border-[var(--line)] shrink-0 max-h-48 overflow-auto"><input className="browser-address w-full" aria-label="查找本地 HTML" value={query} onChange={event => setQuery(event.target.value)} /><div className="mt-2">{files.length ? files.map(path => <button key={path} disabled={busy} className="block w-full px-2 py-1.5 text-left truncate rounded hover:bg-[var(--hover)] text-[12px]" onClick={() => void open({ path })}>{path}</button>) : <p className="text-[12px] text-[var(--muted)]">工作区中未找到匹配的 HTML 文件。</p>}</div></div>}
    <div className="flex flex-wrap gap-2 items-center px-3 py-2 border-y border-[var(--line)] text-[11px] shrink-0"><span className="text-[var(--muted)] flex-1">{tab?.localPath ? '本地沙箱 · 默认断网' : '隔离浏览 · 只读'}</span><button ref={permissionAnchor} aria-expanded={permissions} disabled={!tab} className="status-action" onClick={() => setPermissions(!permissions)}>站点权限{tab?.sources.length ? ' · ' + tab.sources.length : ''}</button><label>缩放 <select aria-label="网页缩放" disabled={!tab} value={tab?.zoom ?? 1} onChange={event => void act('zoom', { zoom: Number(event.target.value) })}>{[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label><Btn type="button" disabled={!tab || tab.loading || busy} onClick={() => picking ? void act('cancel-pick') : void pick()}>{picking ? '取消选取' : '引用页面元素'}</Btn></div>
    {permissions && tab && <Popover anchor={permissionAnchor} label="网页站点权限" width={400} onClose={() => setPermissions(false)}><div data-testid="browser-permissions" className="p-3 space-y-3"><h2 className="font-medium">此标签的网络来源</h2><p className="text-[12px] text-[var(--muted)]">默认限制跨站资源；可单独授权开发 API 或 CDN。只发送 GET / HEAD，不带系统 Cookie 或模型密钥。授权与撤销会刷新当前页；关闭标签后失效。</p>{tab.sources.length ? tab.sources.map(source => <div key={source} className="flex gap-2 items-center text-[12px]"><span className="break-all flex-1">{source}</span>{source !== (() => { try { return new URL(tab.url).origin } catch { return '' } })() ? <Btn onClick={() => { setPermissions(false); void act('revoke-source', { url: source }) }}>撤销</Btn> : <span className="text-[var(--muted)] shrink-0">当前站点</span>}</div>) : <p className="text-[12px]">尚未授权网络来源 · 本地页面保持断网</p>}<input aria-label="新增网页资源来源" className="browser-address w-full" value={sourceURL} onChange={event => setSourceURL(event.target.value)} placeholder="https://cdn.example.com 或本机开发 API" /><Btn v="primary" disabled={!sourceURL || busy} onClick={() => { setPermissions(false); void act('grant-source', { url: sourceURL }) }}>核对来源并授权</Btn><p className="text-[11px] text-[var(--muted)]">表单提交、WebSocket、嵌入页面、下载及设备权限保持关闭。</p></div></Popover>}
    {error && <p role="alert" className="px-3 py-2 text-[12px] text-rose-500 break-words shrink-0">{error}</p>}
    {tab?.error && <p role="alert" className="px-3 py-2 text-[12px] text-rose-500 break-words shrink-0">{tab.error}</p>}
    {tab?.notice && <div className="px-3 py-2 text-[11px] bg-[var(--sunken)] break-words shrink-0">{tab.notice}<button className="ml-2 text-accent" aria-label="关闭网页提示" onClick={() => void act('dismiss-notice')}>关闭</button>{tab.pendingURL && <><p className="break-all mt-1">{tab.pendingURL}</p><Btn type="button" disabled={busy} onClick={() => void open({ url: tab.pendingURL })}>核对并打开新标签</Btn></>}</div>}
    {picking && <p role="status" className="px-3 py-2 text-[12px] text-accent shrink-0">点击页面中的元素添加快照；Esc 取消，30 秒后自动结束。</p>}
    {tab ? <div ref={host} data-testid="browser-viewport" className="flex-1 min-h-24 bg-white relative"><p className="p-4 text-[12px] text-slate-500">隔离网页视图 · 打开浮层时暂时隐藏，关闭后恢复</p></div> : <div className="flex-1 p-8 text-center text-[var(--muted)] text-[13px] leading-7">打开本地 HTML、开发页面或 HTTPS 站点。<br />标签与当前对话关联，关闭面板不会停止任务或开发服务器。</div>}
  </div>
}
