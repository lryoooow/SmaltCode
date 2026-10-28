import { useEffect, useRef, useState } from 'react'
import { errorText, store, type WebSearchProvider, type WebSearchSettingsView, type WebSearchTestResult } from '../bridge'
import { Btn, cx } from './ui'

const names: Record<WebSearchProvider, string> = { tavily: 'Tavily', deepseek: 'DeepSeek' }
type Phase = 'loading' | 'saving' | 'clearing' | 'testing' | 'canceling' | null

function searchError(error: unknown, secret = '') {
  const message = errorText(error)
  if (/not.?configured|未配置|未设置|missing.*(?:key|credential)/i.test(message)) return '请先填写并保存所选服务商的 API Key，再测试连接。'
  if (/401|403|unauthori[sz]ed|invalid.*(?:key|token)|authentication|密钥无效|认证失败/i.test(message)) return '服务商拒绝认证。请检查 API Key 是否正确、已启用，并具有联网搜索权限。'
  if (/429|rate.?limit|too many|限流|频率/i.test(message)) return '服务商请求过于频繁。请稍后重试，并检查账户的请求限额。'
  if (/402|balance|credit|quota|余额|额度|欠费/i.test(message)) return '服务商账户余额或额度不足。请检查账户状态后重试。'
  if (/abort|cancel|取消/i.test(message)) return '连接测试已取消。'
  if (/timeout|timed out|超时/i.test(message)) return '连接测试超时。请检查网络与服务商状态后重试。'
  if (/fetch failed|network|ENOTFOUND|ECONN|网络/i.test(message)) return '暂时无法连接服务商。请检查网络或代理设置后重试。'
  const safe = (secret ? message.split(secret).join('[密钥已隐藏]') : message).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 400)
  return safe || '联网搜索设置操作未完成，请稍后重试。'
}

export default function WebSearchSettings() {
  const api = store.api
  const [config, setConfig] = useState<WebSearchSettingsView>()
  const [provider, setProvider] = useState<WebSearchProvider>('tavily')
  const [enabled, setEnabled] = useState(false)
  const [maxResults, setMaxResults] = useState('5')
  const [key, setKey] = useState('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<WebSearchTestResult>()
  const [confirmClear, setConfirmClear] = useState(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const runningTest = useRef<number>()
  const cancellation = useRef<Promise<void>>(Promise.resolve())
  const current = (id: number) => mounted.current && epoch.current === id
  const cancelRequest = () => {
    const pending = cancellation.current.catch(() => {}).then(async () => { await api?.webSearch('cancel-test') })
    cancellation.current = pending.catch(() => {})
    return pending
  }
  const begin = () => {
    setError(''); setStatus(''); setResult(undefined); setConfirmClear(false)
    return ++epoch.current
  }
  const load = async () => {
    const id = begin(); setPhase('loading')
    try {
      if (!api?.webSearch) throw new Error('当前桌面接口不可用，请重新打开 SmaltCode 后重试。')
      const view = await api.webSearch<WebSearchSettingsView>('get')
      if (!current(id)) return
      setConfig(view); setProvider(view.provider); setEnabled(view.enabled); setMaxResults(String(view.maxResults)); setKey('')
    } catch (e) { if (current(id)) setError(searchError(e)) }
    finally { if (current(id)) setPhase(null) }
  }
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false; ++epoch.current
      if (runningTest.current !== undefined) { runningTest.current = undefined; void cancelRequest() }
    }
  }, [])

  const runTest = async (selected: WebSearchProvider, id: number) => {
    runningTest.current = id; setPhase('testing'); setStatus(`正在测试 ${names[selected]}，可随时取消或关闭设置。`)
    await cancellation.current
    if (!current(id) || !api) return
    const response = await api.webSearch<WebSearchTestResult>('test', { provider: selected })
    if (!current(id)) return
    if (response.provider !== selected) throw new Error('测试返回的服务商与当前选择不一致，请重新测试。')
    setResult(response); setStatus('连接测试完成。')
  }
  const save = async (test = false, clearKey = false) => {
    if (phase || !api || !config) return
    const amount = Number(maxResults)
    if (!/^\d+$/.test(maxResults) || !Number.isInteger(amount) || amount < 1 || amount > 10) { setError('每次搜索的结果数量请填写 1–10 的整数。'); return }
    const selected = provider; const secret = key.trim()
    if (test && !secret && !config.providers[selected].configured) { setError('请先填写 API Key，再保存并测试连接。'); return }
    const id = begin(); setPhase(clearKey ? 'clearing' : 'saving')
    try {
      await api.webSearch('save', { enabled, provider: selected, maxResults: amount, ...(clearKey ? { clearKey: true } : secret ? { apiKey: secret } : {}) })
      if (!current(id)) return
      setKey('')
      const view = await api.webSearch<WebSearchSettingsView>('get')
      if (!current(id)) return
      setConfig(view); setEnabled(view.enabled); setMaxResults(String(view.maxResults))
      if (clearKey) setStatus(`已移除 ${names[selected]} 的密钥，其他服务商密钥保留。`)
      else if (test) await runTest(selected, id)
      else setStatus('联网搜索设置已保存。')
    } catch (e) { if (current(id)) { setStatus(''); setError(searchError(e, secret)) } }
    finally { if (current(id)) { runningTest.current = undefined; setPhase(null) } }
  }
  const testConnection = async () => {
    if (phase || !api || !config?.providers[provider].configured || key.trim()) return
    const selected = provider; const id = begin()
    setPhase('testing')
    try { await runTest(selected, id) }
    catch (e) { if (current(id)) { setStatus(''); setError(searchError(e)) } }
    finally { if (current(id)) { runningTest.current = undefined; setPhase(null) } }
  }
  const cancelTest = async () => {
    if (runningTest.current === undefined) return
    const id = begin(); runningTest.current = undefined; setPhase('canceling'); setStatus('正在取消连接测试…')
    try { await cancelRequest(); if (current(id)) setStatus('连接测试已取消。') }
    catch (e) { if (current(id)) { setStatus(''); setError(searchError(e)) } }
    finally { if (current(id)) setPhase(null) }
  }
  const chooseProvider = (selected: WebSearchProvider) => {
    if (selected === provider) return
    const id = begin(); setProvider(selected); setKey('')
    if (runningTest.current !== undefined) {
      runningTest.current = undefined; setPhase('canceling')
      void cancelRequest().catch(e => { if (current(id)) setError(searchError(e)) }).finally(() => { if (current(id)) setPhase(null) })
    } else setPhase(null)
  }
  const locked = phase !== null
  const configured = config?.providers[provider].configured ?? false
  return <section data-testid="web-search-settings" aria-labelledby="web-search-heading" aria-busy={locked}>
    <h2 id="web-search-heading" className="text-[18px] font-semibold pr-8">联网搜索</h2>
    <p className="mt-1 text-[var(--muted)] leading-relaxed">独立配置搜索服务，与对话模型分开管理。只使用你选择的服务商，不会自动切换到其他服务商。</p>
    {phase === 'loading' && <p role="status" className="mt-5 text-[var(--muted)]">正在读取联网搜索设置…</p>}
    {config && <div className="mt-5 space-y-5">
      <label className="flex items-start gap-3 rounded-xl border border-[var(--line)] p-3 cursor-pointer">
        <input data-testid="web-search-enabled" aria-label="启用联网搜索" type="checkbox" role="switch" checked={enabled} disabled={locked} onChange={e => setEnabled(e.target.checked)} className="mt-1 accent-[var(--accent)]" />
        <span className="min-w-0"><span className="block font-medium">启用联网搜索</span><span className="block mt-1 text-[12px] text-[var(--muted)] leading-relaxed">保存后允许任务按需调用搜索工具。打开此页面不会发送对话，也不会自动测试连接。</span></span>
      </label>
      <div>
        <label htmlFor="web-search-provider" className="text-[12px] text-[var(--muted)]">当前搜索服务商</label>
        <select id="web-search-provider" data-testid="web-search-provider" value={provider} disabled={locked && phase !== 'testing'} onChange={e => chooseProvider(e.target.value as WebSearchProvider)} className="field mt-1 w-full">
          <option value="tavily">Tavily</option><option value="deepseek">DeepSeek</option>
        </select>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">两个服务商的密钥分别保存。切换选择后点击保存，才会更改任务使用的搜索服务。</p>
      </div>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="web-search-key" className="text-[12px] text-[var(--muted)]">{names[provider]} API Key</label><span className={cx('text-[11px]', configured ? 'text-emerald-700 dark:text-emerald-300' : 'text-[var(--muted)]')}>{configured ? '已配置' : '未配置'}</span></div>
        <input id="web-search-key" data-testid="web-search-key" aria-label={names[provider] + ' 搜索 API Key'} type="password" autoComplete="off" spellCheck={false} value={key} disabled={locked} onChange={e => { setKey(e.target.value); setConfirmClear(false) }} placeholder={configured ? '已配置，留空保留原密钥' : '输入该搜索服务的 API Key'} className="field mt-1 w-full font-mono" />
        <p className="mt-1.5 text-[11px] text-[var(--muted)] leading-relaxed">{config.storage === 'encrypted' ? '密钥由系统加密保存在本机，不会回传到此页面。' : '系统加密不可用，密钥仅在本次运行中可用，退出后需重新填写。'} 留空保存不会删除密钥。</p>
        {configured && <button data-testid="web-search-clear-key" type="button" disabled={locked} onClick={() => setConfirmClear(true)} className="mt-2 text-[11px] text-rose-600 dark:text-rose-300 hover:underline disabled:opacity-40">移除 {names[provider]} 密钥</button>}
        {confirmClear && <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px]">
          <p>确定移除 {names[provider]} 的密钥？此操作同时保存当前搜索开关、服务商与结果数量，其他服务商的密钥保留。</p>
          <div className="flex flex-wrap gap-2 mt-3"><Btn data-testid="web-search-confirm-clear-key" v="danger" disabled={locked} onClick={() => void save(false, true)}>确认移除密钥</Btn><Btn v="outline" disabled={locked} onClick={() => setConfirmClear(false)}>取消</Btn></div>
        </div>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[120px_minmax(0,1fr)] gap-3 items-start">
        <div><label htmlFor="web-search-max-results" className="text-[12px] text-[var(--muted)]">每次结果数量</label><input id="web-search-max-results" data-testid="web-search-max-results" aria-label="搜索结果数量" type="number" inputMode="numeric" min={1} max={10} step={1} value={maxResults} disabled={locked} onChange={e => setMaxResults(e.target.value)} className="field mt-1 w-full" /></div>
        <div className="min-w-0"><div className="text-[12px] text-[var(--muted)]">官方服务端点</div><p className="mt-2 text-[11px] text-[var(--muted)] font-mono break-all">{config.providers[provider].endpoint}</p></div>
      </div>
      {config.notice && <p className="rounded-lg bg-amber-500/10 p-3 text-[12px] text-amber-800 dark:text-amber-200 break-words">{config.notice}</p>}
      <div className="border-t border-[var(--line)] pt-4">
        <p id="web-search-test-notice" className="text-[11px] text-[var(--muted)] leading-relaxed">连接测试会向所选服务商发送一条内置的公开查询，可能产生服务费用，不会使用当前对话内容。单独测试使用已保存的配置；更换密钥后请先保存。</p>
        <div className="flex flex-wrap gap-2 mt-3">
          <Btn data-testid="web-search-save" v="primary" disabled={locked} onClick={() => void save()}>{phase === 'saving' ? '正在保存…' : '保存设置'}</Btn>
          <Btn data-testid="web-search-save-test" v="outline" aria-describedby="web-search-test-notice" disabled={locked || (!configured && !key.trim())} onClick={() => void save(true)}>保存并测试连接</Btn>
          <Btn data-testid="web-search-test" v="outline" aria-describedby="web-search-test-notice" disabled={locked || !configured || !!key.trim()} onClick={() => void testConnection()}>测试已保存配置</Btn>
          {phase === 'testing' && <Btn data-testid="web-search-cancel-test" v="outline" onClick={() => void cancelTest()}>取消测试</Btn>}
        </div>
      </div>
    </div>}
    {error && <div data-testid="web-search-error" role="alert" className="mt-4 rounded-lg bg-rose-500/10 p-3 text-[12px] text-rose-700 dark:text-rose-300 break-words">{error}</div>}
    {status && <p data-testid="web-search-status" role="status" aria-live="polite" className="mt-4 text-[12px] text-[var(--muted)] break-words">{status}</p>}
    {result && <div data-testid="web-search-result" className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
      <p className="font-medium text-emerald-700 dark:text-emerald-300">{names[result.provider]} · 返回 {result.count} 项结果</p><p className="mt-1 text-[12px] break-words">{result.message}</p>
      {result.sources.length > 0 && <ul className="mt-3 space-y-2 text-[11px]">{result.sources.slice(0, 10).map((source, index) => <li key={index} className="min-w-0"><div className="font-medium break-words">{source.title || '未命名来源'}</div><div className="mt-0.5 text-[var(--muted)] break-all">{source.url}</div></li>)}</ul>}
    </div>}
    {!config && phase !== 'loading' && <Btn v="outline" className="mt-3" onClick={() => void load()}>重新读取设置</Btn>}
  </section>
}
