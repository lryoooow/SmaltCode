import type { ProviderConfig } from '../config/settings.js';
import { officialModel, providerKind, type ModelInfo } from './profiles.js';

export function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Resolve the selected model, never infer a proxy's limits from its model name. */
export function resolveContextWindow(config: Pick<ProviderConfig, 'baseUrl' | 'wire' | 'contextWindow' | 'modelContextWindows'>, model: string, discovered?: ModelInfo): { tokens: number; source: 'modelOverride' | 'providerOverride' | 'api' | 'official' | 'fallback' } {
  const specific = Object.hasOwn(config.modelContextWindows ?? {}, model) ? config.modelContextWindows?.[model] : undefined;
  if (validContextWindow(specific)) return { tokens: specific, source: 'modelOverride' };
  if (validContextWindow(config.contextWindow)) return { tokens: config.contextWindow, source: 'providerOverride' };
  const info = discovered?.id === model ? discovered : officialModel(config, model);
  const limits = [info?.contextWindow, info?.maxInputTokens].filter(validContextWindow);
  if (limits.length) return { tokens: Math.min(...limits), source: info!.source };
  return { tokens: providerKind(config) === 'ollama' ? 4096 : config.wire === 'anthropic' ? 200_000 : 128_000, source: 'fallback' };
}
