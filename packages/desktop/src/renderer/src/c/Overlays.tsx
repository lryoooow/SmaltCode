import { useEffect, useRef, useState } from 'react'
import Icon from './icons'
import { Btn, cx, Kbd, Logo, MODES, type Task } from './ui'
import { errorText, folderName, store, type SettingsData } from '../bridge'
import { resolveContextWindow, validContextWindow } from '../../../../../kernel/src/models/context-window'
import ModelPicker from './ModelPicker'
import WebSearchSettings from './WebSearchSettings'
import { capacitySource, modelChoices } from './model-choices'

export function Modal({ children, onClose, w = 'w-[860px]', label = '对话框', bare = false, layer = 70 }: { children: React.ReactNode; onClose: () => void; w?: string; label?: string; bare?: boolean; layer?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const dialog = ref.current!
    const timer = setTimeout(() => { if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('button,input,textarea,select')?.focus() }, 0)
    const handler = (event: KeyboardEvent) => {
      if ([...document.querySelectorAll('[role="dialog"]')].at(-1) !== dialog) return
      if (event.key === 'Escape') { event.stopPropagation(); close.current() }
      if (event.key === 'Tab') {
        const all = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(el => el.getClientRects().length > 0)
        const first = all[0]; const last = all.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => { clearTimeout(timer); document.removeEventListener('keydown', handler, true); before?.focus() }
  }, [])
  return <div style={{ zIndex: layer }} className={bare ? "fixed inset-0 grid place-items-center" : "fixed inset-0 grid place-items-center bg-black/25 backdrop-blur-[3px] anim-fade"} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={bare ? 'w-full h-full' : cx(w, 'max-w-[92vw] max-h-[90vh] rounded-2xl bg-[var(--surface-solid)] border border-[var(--line)] shadow-[0_30px_80px_-20px_rgba(0,0,0,.4)] anim-pop overflow-auto')}>{children}</div></div>
}
export function Palette({ tasks, onClose, onPick, actions }: { tasks: Task[]; onClose: () => void; onPick: (id: string) => void; actions: { label: string; icon: string; k: string; run: () => void }[] }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const items = [...actions.filter((a) => a.label.includes(q)).map((a) => ({ ...a, type: '操作' })), ...tasks.filter((t) => t.title.includes(q)).map((t) => ({ label: t.title, icon: 'chat', k: t.ws, type: '任务', run: () => onPick(t.id) }))]
  return (
    <Modal onClose={onClose} w="w-[560px]">
      <div className="flex items-center gap-3 px-4 h-14 border-b border-[var(--line)]">
        <Icon n="search" s={18} className="text-[var(--muted)]" />
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setI(0) }} placeholder="搜索任务或输入命令…" className="flex-1 bg-transparent outline-none text-[15px]"
          onKeyDown={(e) => { if (e.key === 'ArrowDown') setI(Math.min(i + 1, items.length - 1)); if (e.key === 'ArrowUp') setI(Math.max(i - 1, 0)); if (e.key === 'Enter' && items[i]) { items[i].run(); onClose() } }} />
        <Kbd>Esc</Kbd>
      </div>
      <div className="max-h-[360px] overflow-y-auto p-1.5">
        {items.length === 0 && <div className="py-10 text-center text-[var(--muted)]">没有找到"{q}"相关结果</div>}
        {items.map((it, j) => (
          <div key={j}>
            {(j === 0 || items[j - 1].type !== it.type) && <div className="px-2.5 pt-2 pb-1 text-[11px] text-[var(--muted)]">{it.type}</div>}
            <button onMouseEnter={() => setI(j)} onClick={() => { it.run(); onClose() }} className={cx('w-full flex items-center gap-3 px-2.5 h-9 rounded-lg text-left transition-colors', i === j && 'bg-[var(--accent-soft)]')}>
              <Icon n={it.icon} s={15} className={i === j ? 'text-accent' : 'text-[var(--muted)]'} /><span className="flex-1 truncate">{it.label}</span><span className="text-[11.5px] text-[var(--muted)]">{it.k}</span>
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}


export const PROVIDER_NAMES: Record<string, string> = { deepseek: 'DeepSeek', zhipu: '智谱 GLM', moonshot: 'Kimi', dashscope: '通义千问', openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', ollama: 'Ollama 本地' }
export function Settings({ onClose, dark, setDark, settings }: { onClose: () => void; dark: boolean; setDark: (value: boolean) => void; settings: SettingsData }) {
  const [sec, setSec] = useState('model')
  const [provider, setProvider] = useState(settings.effective.defaultProvider)
  const [url, setUrl] = useState('')
  const [model, setModel] = useState('')
  const [key, setKey] = useState('')
  const [windowTokens, setWindowTokens] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  const [error, setError] = useState<string>()
  const [permission, setPermission] = useState(settings.effective.permissionMode)
  useEffect(() => {
    const config = settings.providers[provider]
    setUrl(config?.baseUrl ?? '')
    setModel(provider === settings.effective.defaultProvider ? settings.effective.defaultModel : config?.defaultModel ?? '')
    setKey(''); setResult(undefined); setError(undefined)
  }, [provider])
  useEffect(() => { setWindowTokens(String(settings.providers[provider]?.modelContextWindows?.[model] ?? '')) }, [provider, model])
  const catalog = settings.catalogs?.[provider]
  const discovered = url.replace(/\/+$/, '') === settings.providers[provider]?.baseUrl.replace(/\/+$/, '') ? catalog?.models.find(m => m.id === model.trim()) : undefined
  const context = resolveContextWindow({ ...settings.providers[provider], baseUrl: url, modelContextWindows: { [model.trim()]: windowTokens ? Number(windowTokens) : null } }, model.trim(), discovered)
  const fetchModels = async () => {
    const endpoint = new URL(url)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('请填写有效的服务地址')
    await store.updateSettings({ providers: { [provider]: { baseUrl: url.replace(/\/+$/, ''), ...(key.trim() ? { apiKey: key.trim() } : {}) } } })
    setKey('')
    const result = await store.loadModels(provider, true)
    if (result?.error) throw new Error(result.error)
  }
  const resetCapacity = async () => {
    setBusy(true); setError(undefined); setResult(undefined)
    try { await store.updateSettings({ providers: { [provider]: { contextWindow: null, modelContextWindows: { [model.trim()]: null } } } }); setWindowTokens(''); setResult('已清除服务商固定容量和当前模型的容量覆盖，恢复自动识别；其他模型的单独设置保留。') }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const save = async (test = false) => {
    setBusy(true); setError(undefined); setResult(undefined)
    try {
      if (!model.trim()) throw new Error('请填写模型 ID')
      if (windowTokens && !validContextWindow(Number(windowTokens))) throw new Error('上下文窗口请填写正整数 Token 数，留空使用自动设置')
      const endpoint = new URL(url)
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('请填写有效的 HTTP 或 HTTPS 服务地址')
      await store.updateSettings({ defaultProvider: provider, defaultModel: model.trim(), providers: { [provider]: { baseUrl: url.replace(/\/$/, ''), defaultModel: model.trim(), modelContextWindows: { [model.trim()]: windowTokens ? Number(windowTokens) : null }, ...(key ? { apiKey: key.trim() } : {}) } } })
      setKey('')
      await store.loadModels(provider, false, model.trim())
      if (test) { await store.api!.testProvider(provider, model.trim()); setResult('连接成功，模型已返回响应') }
      else setResult('设置已保存，新任务将使用此模型')
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const savePermissions = async () => {
    setBusy(true); setError(undefined); setResult(undefined)
    try { await store.updateSettings({ permissions: { mode: permission } }); setResult('权限模式已保存') }
    catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const sections = [['general', '通用', 'gear'], ['look', '外观', 'sun'], ['model', '模型服务商', 'cpu'], ['web-search', '联网搜索', 'search'], ['perm', '权限与安全', 'shield'], ['keys', '快捷键', 'list'], ['about', '关于', 'info']]
  return <Modal onClose={onClose} label="设置"><div className="flex h-[580px] max-h-[85vh]">
    <nav className="w-32 sm:w-44 shrink-0 overflow-y-auto bg-[var(--sunken)] border-r border-[var(--line)] p-2.5"><div className="px-2.5 py-2 text-[15px] font-semibold">设置</div>{sections.map(([id, label, icon]) => <button key={id} data-testid={'settings-' + id} aria-current={sec === id ? 'page' : undefined} onClick={() => { setSec(id); setResult(undefined); setError(undefined) }} className={cx('w-full flex items-center gap-2.5 px-2.5 min-h-9 py-1.5 rounded-lg text-left transition', sec === id ? 'bg-[var(--surface-solid)] shadow-sm font-medium' : 'text-[var(--muted)] hover:bg-[var(--hover)]')}><Icon n={icon} s={15} className={sec === id ? 'text-accent shrink-0' : 'shrink-0'} />{label}</button>)}</nav>
    <div className="flex-1 min-w-0 min-h-0 relative"><button aria-label="关闭设置" onClick={onClose} className="absolute z-10 right-4 top-4 size-7 grid place-items-center rounded-md bg-[var(--surface-solid)] hover:bg-[var(--hover)] text-[var(--muted)]"><Icon n="x" s={16} /></button><div className="h-full overflow-y-auto p-4 sm:p-7">
      {sec === 'web-search' && <WebSearchSettings />}
      {sec === 'model' && <div><h2 className="text-[18px] font-semibold">模型服务商</h2><p className="text-[var(--muted)] mt-1">{settings.keyStorage === 'encrypted' ? 'API Key 由系统加密保存在本机。' : '系统加密不可用，输入的密钥仅用于本次运行。'}</p>
        <div className="grid grid-cols-4 gap-2 mt-5">{Object.entries(settings.providers).map(([id, config]) => <button key={id} onClick={() => setProvider(id)} disabled={busy} className={cx('p-2.5 rounded-xl border text-left transition', provider === id ? 'border-accent bg-[var(--accent-soft)]' : 'border-[var(--line)] hover:bg-[var(--hover)]')}><div className="text-[12px] font-medium">{PROVIDER_NAMES[id] ?? id}</div><div className={cx('text-[10.5px] mt-1', config.hasKey ? 'text-emerald-600' : 'text-[var(--muted)]')}>{config.hasKey ? '已配置' : '待配置'}</div></button>)}</div>
        <div className="mt-5 space-y-3">
          <label className="block text-[12px] text-[var(--muted)]">API Key<div className="flex mt-1 gap-1"><input aria-label="API Key" autoComplete="off" type={show ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)} placeholder={settings.providers[provider]?.hasKey ? '已设置，留空保留原密钥' : settings.providers[provider]?.apiKeyEnv ? '也可使用环境变量 ' + settings.providers[provider].apiKeyEnv : '输入服务商密钥'} className="field flex-1 min-w-0" /><button aria-label={show ? '隐藏密钥' : '显示密钥'} onClick={() => setShow(!show)} className="px-2 text-[var(--muted)]"><Icon n="eye" s={16} /></button></div></label>
          <label className="block text-[12px] text-[var(--muted)]">服务地址<input aria-label="服务地址" value={url} onChange={e => setUrl(e.target.value)} className="field mt-1 w-full font-mono" /></label>
          <div><div className="flex items-center justify-between gap-2"><span className="text-[12px] text-[var(--muted)]">模型</span><ModelPicker label="浏览服务商模型" value={provider + '/' + model} choices={modelChoices(settings, provider + '/' + model)} onChange={id => setModel(id.slice(provider.length + 1))} onlyProvider={provider} names={PROVIDER_NAMES} onRefresh={fetchModels} disabled={busy} /></div><input aria-label="模型 ID" placeholder="从列表选择，也可填写自定义模型 ID" value={model} onChange={e => setModel(e.target.value)} className="field mt-1 w-full font-mono" /><p className="mt-1 text-[10.5px] text-[var(--muted)]">{catalog?.checkedAt !== undefined ? `${catalog.source === 'api' ? '已获取' : '已同步官方目录'} ${catalog.models.length} 个模型${catalog.checkedAt ? ' · ' + new Date(catalog.checkedAt).toLocaleString() : ''}${catalog.stale ? ' · 缓存待刷新' : ''}` : '内置目录可离线浏览；刷新会保存当前地址与密钥，仅请求模型信息。'}</p>{discovered?.unavailableReason && <p role="status" className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{discovered.unavailableReason}</p>}</div>
          <label className="block text-[12px] text-[var(--muted)]">上下文窗口（Token）<input aria-label="上下文窗口" inputMode="numeric" value={windowTokens} onChange={e => setWindowTokens(e.target.value)} placeholder={`自动 · ${context.tokens.toLocaleString()} Token`} className="field mt-1 w-full font-mono" /><span data-testid="context-window-hint" className="block mt-1.5 leading-relaxed">{context.source === 'official' ? '官方模型规格' : context.source === 'fallback' ? '未识别实际容量，暂用保守值；可手动填写实际限制' : capacitySource[context.source]} · {context.tokens.toLocaleString()} Token，约 {Math.floor(context.tokens * (settings.compactThreshold ?? .8)).toLocaleString()} Token 时自动整理。留空恢复自动设置；运行中的任务沿用启动时的配置。{discovered?.maxInputTokens && discovered.contextWindow && discovered.maxInputTokens < discovered.contextWindow ? ` 模型总窗口 ${discovered.contextWindow.toLocaleString()} Token，当前按输入上限预算。` : ''}</span></label>
          {(context.source === 'providerOverride' || context.source === 'modelOverride') && <button disabled={busy || !model.trim()} onClick={() => void resetCapacity()} className="text-[11px] text-accent hover:underline disabled:opacity-50">恢复自动容量</button>}
        </div><div className="flex gap-2 mt-5"><Btn v="primary" disabled={busy} onClick={() => void save()}>保存并设为默认</Btn><Btn v="outline" disabled={busy} onClick={() => void save(true)}>{busy ? '正在处理…' : '保存并测试连接'}</Btn></div><p className="text-[11px] text-[var(--muted)] mt-2">测试会发送一条简短请求，可能产生少量模型费用。</p>
      </div>}
      {sec === 'look' && <div><h2 className="text-[18px] font-semibold">外观</h2><p className="text-[var(--muted)] mt-1">主题保存在本机，下次启动自动恢复。</p><div className="grid grid-cols-2 gap-3 mt-6">{[false, true].map(value => <button key={String(value)} onClick={() => setDark(value)} className={cx('rounded-xl border p-4 text-left', dark === value ? 'border-accent bg-[var(--accent-soft)]' : 'border-[var(--line)]')}><div className={cx('h-24 rounded-lg border mb-3 flex p-2 gap-2', value ? 'bg-[#11151c] border-[#303541]' : 'bg-[#eef0f4] border-[#dfe3eb]')}><div className={cx('w-8 rounded', value ? 'bg-[#232a38]' : 'bg-white')} /><div className={cx('flex-1 rounded', value ? 'bg-[#1a1f2a]' : 'bg-white')} /></div>{value ? '深色' : '浅色'}</button>)}</div></div>}
      {sec === 'perm' && <div><h2 className="text-[18px] font-semibold">权限与安全</h2><p className="text-[var(--muted)] mt-1">设置新任务的默认权限。运行中的任务保持当前模式。</p><div className="space-y-2 mt-5">{MODES.filter(m => !m.danger).map(m => <button key={m.id} onClick={() => setPermission(m.id)} className={cx('w-full flex gap-3 p-3 rounded-xl border text-left', permission === m.id ? 'border-accent bg-[var(--accent-soft)]' : 'border-[var(--line)]')}><Icon n={m.icon} s={18} className="text-accent" /><div><div className="font-medium">{m.label}</div><div className="text-[12px] text-[var(--muted)]">{m.desc}</div></div></button>)}</div><Btn className="mt-4" v="primary" disabled={busy} onClick={() => void savePermissions()}>保存权限模式</Btn></div>}
      {sec === 'general' && <div><h2 className="text-[18px] font-semibold">通用</h2><div className="mt-6 space-y-5"><div><div className="font-medium">本地保存</div><p className="mt-1 text-[var(--muted)]">新对话自动使用独立本地空间，无需选择项目或文件夹。需要处理已有目录时，再在对话设置中关联资料文件夹。已有对话保留创建时的工作位置。</p></div><div><div className="font-medium">任务记录</div><p className="mt-1 text-[var(--muted)]">对话由内核保存到本机，重启后可继续。</p></div><div><div className="font-medium">语言</div><p className="mt-1 text-[var(--muted)]">简体中文</p></div></div></div>}
      {sec === 'keys' && <div><h2 className="text-[18px] font-semibold">快捷键</h2><div className="mt-5 space-y-4">{[['新建任务', 'Ctrl N'], ['搜索任务', 'Ctrl K'], ['切换侧边栏', 'Ctrl B'], ['切换右侧面板', 'Ctrl J'], ['打开设置', 'Ctrl ,'], ['发送消息', 'Enter'], ['输入换行', 'Shift Enter']].map(([label, key]) => <div key={label} className="flex justify-between"><span>{label}</span><Kbd>{key}</Kbd></div>)}</div></div>}
      {sec === 'about' && <div><Logo s={44} /><h2 className="text-[22px] font-semibold mt-4">SmaltCode</h2><p className="text-[var(--muted)] mt-2">多模型 AI 编程与办公助手</p><div className="mt-6 space-y-3 text-[13px]"><div>桌面版本 {store.api?.version ?? '—'}</div><div>开源协议 Apache-2.0</div><div className="text-[var(--muted)]">公开测试版，欢迎反馈建议与问题。</div></div></div>}
      {error && <div role="alert" className="mt-4 p-3 rounded-lg bg-rose-500/10 text-rose-600 break-words">{error}</div>}
      {result && <div role="status" className="mt-4 p-3 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">{result}</div>}
    </div></div>
  </div></Modal>
}
export function Onboarding({ onDone, onSettings, onPickFolder, workspace, configured }: { onDone: () => void; onSettings: () => void; onPickFolder: () => Promise<void>; workspace: string; configured: boolean }) {
  const [step, setStep] = useState(0)
  return <Modal bare layer={60} label="欢迎使用 SmaltCode" onClose={onDone}><div data-testid="onboarding" className="fixed inset-0 z-[60] grid place-items-center bg-[var(--bg)]/95 backdrop-blur-xl"><div className="w-[460px] max-w-[90vw] anim-rise">
    <div className="flex justify-center mb-7"><Logo s={56} /></div>
    <div className="text-center mb-6"><h1 className="text-[24px] font-semibold">让工作，从容一点</h1><p className="text-[var(--muted)] mt-2">把繁琐的事情交给 SmaltCode，把时间留给你。</p></div>
    <div className="flex justify-center gap-2 mb-6">{[0, 1, 2].map(i => <span key={i} className={cx('h-1 w-8 rounded-full transition', i === step ? 'bg-accent' : 'bg-[var(--line)]')} />)}</div>
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-solid)] p-6 shadow-xl">
      {step === 0 && <><h2 className="text-[18px] font-semibold">连接你的模型</h2><p className="text-[var(--muted)] mt-2 leading-relaxed">选择服务商，填写密钥与模型 ID，即可开始。也支持本机 Ollama。</p><Btn v="outline" className="mt-5 w-full" onClick={onSettings}><Icon n="cpu" s={16} />{configured ? '查看模型配置' : '配置模型服务商'}</Btn>{configured && <p className="mt-3 text-[12px] text-emerald-600">已配置可用服务商</p>}<div className="flex justify-end mt-6"><Btn v="primary" onClick={() => setStep(1)}>下一步</Btn></div></>}
      {step === 1 && <><h2 className="text-[18px] font-semibold">自动保存到本地</h2><p className="text-[var(--muted)] mt-2">不用先选项目或文件夹。历史、附件和生成文件由本机的独立存储空间管理；处理已有资料时再关联目录。</p><button onClick={() => void onPickFolder()} className="w-full flex items-center gap-3 p-4 mt-5 rounded-xl border border-[var(--line)] hover:bg-[var(--hover)] text-left"><Icon n="folder" s={24} className="text-accent" /><div className="min-w-0"><div className="font-medium">{workspace ? folderName(workspace) : '关联资料文件夹（可选）'}</div><div className="text-[11px] text-[var(--muted)] break-all mt-1">{workspace || '只在需要读写已有资料目录时选择'}</div></div></button><div className="flex justify-between mt-6"><Btn onClick={() => setStep(0)}>上一步</Btn><Btn v="primary" onClick={() => setStep(2)}>下一步</Btn></div></>}
      {step === 2 && <><h2 className="text-[18px] font-semibold">过程清晰，操作可控</h2><div className="mt-5 space-y-4">{[['eye', '看见工作过程', '思考、执行命令和文件变更会实时显示。'], ['shield', '敏感操作先确认', '默认在执行敏感操作前请求审批。'], ['file', '拿到实际产物', '默认保存到独立本地空间；明确关联目录时使用该目录。']].map(([icon, title, text]) => <div key={title} className="flex gap-3"><Icon n={icon} s={18} className="text-accent mt-1" /><div><div className="font-medium">{title}</div><p className="text-[12px] text-[var(--muted)] mt-1">{text}</p></div></div>)}</div><div className="flex justify-between mt-6"><Btn onClick={() => setStep(1)}>上一步</Btn><Btn v="primary" onClick={onDone}>开始工作</Btn></div></>}
    </div>
    <button onClick={onDone} className="block mx-auto mt-5 text-[12.5px] text-[var(--muted)] hover:text-[var(--text)]">跳过，稍后在设置中配置</button>
  </div></div></Modal>
}
