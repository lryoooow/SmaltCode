import type { SettingsData } from '../bridge'
import { resolveContextWindow } from '../../../../../kernel/src/models/context-window'
import type { ModelInfo } from '../../../../../kernel/src/models/profiles'

export type ModelChoice = { id: string; label: string; provider: string; info?: ModelInfo; window: number; source: string; disabled?: string; stale?: boolean; configured: boolean }
export const capacitySource: Record<string, string> = { modelOverride: '手动设置', providerOverride: '服务商配置', api: '接口识别', official: '官方规格', fallback: '容量待确认' }
export function modelChoices(settings?: SettingsData, current?: string): ModelChoice[] {
  if (!settings) return []
  const result: ModelChoice[] = []
  for (const [provider, config] of Object.entries(settings.providers)) {
    const catalog = settings.catalogs?.[provider]
    const known = new Map((catalog?.models ?? []).map(info => [info.id, info]))
    const saved = provider === settings.effective.defaultProvider ? settings.effective.defaultModel : config.defaultModel
    if (saved && !known.has(saved)) known.set(saved, { id: saved, name: saved, source: 'api' })
    if (current?.startsWith(provider + '/') && !known.has(current.slice(provider.length + 1))) { const id = current.slice(provider.length + 1); known.set(id, { id, name: id, source: 'api' }) }
    for (const info of known.values()) {
      const capacity = resolveContextWindow(config, info.id, info)
      result.push({ id: provider + '/' + info.id, label: info.name, provider, info, window: capacity.tokens, source: capacitySource[capacity.source], stale: catalog?.checkedAt !== undefined && catalog.stale, configured: config.hasKey, disabled: !config.hasKey ? '请先在设置中配置此服务商' : info.unavailableReason })
    }
  }
  return result
}
