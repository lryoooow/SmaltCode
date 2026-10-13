/**
 * ModelGateway — resolves provider/model references to concrete adapters and
 * streams unified deltas. The kernel loop only ever talks to this.
 */

import { apiKeyFor, type ModelRef, type ProviderConfig, type Settings } from '../config/settings.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { ChatCompletionsAdapter } from './adapters/chat.js';
import type { ModelAdapter, ModelDelta, ModelRequest } from './types.js';

export class ModelGateway {
  private readonly adapters = new Map<string, ModelAdapter>();
  private readonly providerOverrides: Record<string, Partial<ProviderConfig>> = {};

  constructor(private settings: Settings) {}

  getSettings(): Settings {
    return this.settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.adapters.clear();
  }

  fork(settings: Settings): ModelGateway {
    const fork = new ModelGateway(settings);
    for (const [name, patch] of Object.entries(this.providerOverrides)) fork.overrideProvider(name, patch);
    return fork;
  }

  /** Test/CLI override for provider config (e.g. a custom baseUrl for one run). */
  overrideProvider(name: string, patch: Partial<ProviderConfig>): void {
    this.providerOverrides[name] = { ...(this.providerOverrides[name] ?? {}), ...patch };
    this.adapters.delete(name);
  }

  providerConfig(name: string): ProviderConfig {
    const base =
      this.settings.providers[name] ??
      this.settings.providers[this.settings.defaultProvider] ?? {
        baseUrl: 'https://api.openai.com/v1',
        wire: 'chat' as const,
      };
    return { ...base, ...(this.providerOverrides[name] ?? {}) };
  }

  adapterFor(providerName: string): ModelAdapter {
    const cached = this.adapters.get(providerName);
    if (cached) return cached;
    const cfg = this.providerConfig(providerName);
    const adapter: ModelAdapter =
      cfg.wire === 'anthropic'
        ? new AnthropicAdapter({
            baseUrl: cfg.baseUrl,
            apiKey: apiKeyFor(cfg) ?? '',
            contextWindow: cfg.contextWindow,
          })
        : new ChatCompletionsAdapter({
            baseUrl: cfg.baseUrl,
            apiKey: apiKeyFor(cfg) ?? 'none',
            contextWindow: cfg.contextWindow,
          });
    this.adapters.set(providerName, adapter);
    return adapter;
  }

  contextWindowFor(ref: ModelRef): number {
    return this.providerConfig(ref.provider).contextWindow ?? 128_000;
  }

  /** Stream a request using a provider/model reference. */
  async *stream(ref: ModelRef, req: Omit<ModelRequest, 'model'>): AsyncIterable<ModelDelta> {
    const adapter = this.adapterFor(ref.provider);
    yield* adapter.stream({ ...req, model: ref.model });
  }
}
