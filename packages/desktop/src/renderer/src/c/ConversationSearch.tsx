import { useEffect, useRef, useState } from 'react'
import type { Item } from '../bridge'
import type { OperationIssue } from './issues'
import { searchConversation, type SearchScope, type ConversationHit } from './conversation-search'
import { IconBtn, cx } from './ui'

export default function ConversationSearch({ items, issues, onLocate, onClose }: { items: Item[]; issues: OperationIssue[]; onLocate: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''), [scope, setScope] = useState<SearchScope>('all'), [hits, setHits] = useState<ConversationHit[]>([])
  const [loading, setLoading] = useState(false), [truncated, setTruncated] = useState(false), [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null)
  const currentItems = useRef(items), currentIssues = useRef(issues); currentItems.current = items; currentIssues.current = issues
  // Search is an explicit snapshot; live output doesn't reset the user's selected result.
  const [refresh, setRefresh] = useState(0), snapshotCount = useRef(0)
  useEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    const timer = setTimeout(() => {
      const snapshot = currentItems.current; snapshotCount.current = snapshot.length
      void searchConversation(snapshot, currentIssues.current, query, scope, controller.signal).then(result => {
        if (!controller.signal.aborted) { setHits(result.hits); setTruncated(result.truncated); setSelected(0); setLoading(false) }
      })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, scope, refresh])
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const move = (by: number) => { if (hits.length) { const next = (selected + by + hits.length) % hits.length; setSelected(next); onLocate(hits[next]!.id) } }
  return <section data-testid="conversation-search" aria-label="对话内搜索" className="conversation-search" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key === 'Enter') { event.preventDefault(); if (hits.length) { if (event.shiftKey) move(-1); else onLocate(hits[selected]!.id) } }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
  }}>
    <div className="flex items-center gap-2 min-w-0"><input ref={input} aria-label="搜索当前对话" maxLength={300} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索正文、执行输出或文件…" className="min-w-0 flex-1 bg-transparent outline-none text-[13px]" />
      <select aria-label="搜索范围" value={scope} onChange={e => setScope(e.target.value as SearchScope)} className="bg-[var(--surface-solid)] text-[12px] rounded px-1 py-1"><option value="all">全部</option><option value="messages">消息</option><option value="execution">执行</option><option value="files">文件</option><option value="issues">问题</option></select>
      <IconBtn n="x" label="关闭对话搜索" onClick={onClose} /></div>
    <div className="flex items-center gap-2 mt-1 text-[12px] text-[var(--muted)]"><span role="status">{loading ? '正在检索…' : !query.trim() ? '仅在当前对话内检索，不调用模型' : `${hits.length}${truncated ? '+' : ''} 条匹配记录`}</span><span className="flex-1" /><button className="text-accent" onClick={() => setRefresh(value => value + 1)}>{items.length !== snapshotCount.current ? '有新记录 · 刷新' : '刷新结果'}</button><button aria-label="上一条搜索结果" disabled={!hits.length} onClick={() => move(-1)}>↑</button><button aria-label="下一条搜索结果" disabled={!hits.length} onClick={() => move(1)}>↓</button></div>
    {!!hits.length && <div ref={list} role="listbox" aria-label="对话搜索结果" className="mt-2 max-h-44 overflow-auto">{hits.map((hit, index) => <button key={hit.id} role="option" aria-selected={selected === index} className={cx('search-result', selected === index && 'is-active')} onClick={() => { setSelected(index); onLocate(hit.id) }}><span className="block text-[12px] font-medium truncate">{hit.title}</span><span className="block whitespace-pre-wrap break-words text-[12px] text-[var(--muted)]">{hit.snippet.slice(0, hit.start)}<mark>{hit.snippet.slice(hit.start, hit.end)}</mark>{hit.snippet.slice(hit.end)}</span></button>)}</div>}
    {!loading && !!query.trim() && !hits.length && <p className="mt-2 text-[12px] text-[var(--muted)]">没有匹配记录，试试其他关键词或范围。</p>}
    {truncated && <p className="mt-1 text-[12px] text-[var(--muted)]">最多展示 200 条，请缩小关键词或范围。</p>}
  </section>
}
