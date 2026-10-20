/**
 * ModelGateway — resolves provider/model references to concrete adapters and
 * streams unified deltas. The kernel loop only ever talks to this.
 */

import { apiKeyFor, normalizeEndpoint, smaltHome, type ModelRef, type ProviderConfig, type Settings } from '../config/settings.js';
import { join } from 'node:path';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { ChatCompletionsAdapter } from './adapters/chat.js';
import { ModelError, type ModelAdapter, type ModelDelta, type ModelRequest } from './types.js';
import { resolveContextWindow } from './context-window.js';
import { ModelCatalog } from './catalog.js';
import { providerKind } from './profiles.js';

export class ModelGateway {
  private readonly adapters = new Map<string, ModelAdapter>();
  private readonly providerOverrides: Record<string, Partial<ProviderConfig>> = {};

  private readonly catalog: ModelCatalog;
  constructor(private settings: Settings, private readonly options: { automaticDiscovery?: boolean; catalog?: ModelCatalog } = {}) {
    this.catalog = options.catalog ?? new ModelCatalog({ file: join(smaltHome(), 'model-catalog.json') });
  }

  getSettings(): Settings {
    return this.settings;
  }

  updateSettings(settings: Settings): void {
    for (const [name, override] of Object.entries(this.providerOverrides)) {
      if (normalizeEndpoint(settings.providers[name]?.baseUrl ?? '') !== normalizeEndpoint(override.apiKeyEndpoint ?? this.settings.providers[name]?.baseUrl ?? '')) delete this.providerOverrides[name];
    }
    this.settings = settings;
    this.adapters.clear();
  }

  fork(settings: Settings): ModelGateway {
    const fork = new ModelGateway(settings, { ...this.options, catalog: this.catalog });
    for (const [name, patch] of Object.entries(this.providerOverrides)) fork.overrideProvider(name, patch);
    return fork;
  }

  /** Test/CLI override for provider config (e.g. a custom baseUrl for one run). */
  overrideProvider(name: string, patch: Partial<ProviderConfig>): void {
    if (patch.apiKey !== undefined) patch = { ...patch, apiKeyEnv: '', apiKeyEndpoint: patch.apiKeyEndpoint ?? normalizeEndpoint(patch.baseUrl ?? this.settings.providers[name]?.baseUrl ?? '') };
    this.providerOverrides[name] = { ...(this.providerOverrides[name] ?? {}), ...patch };
    this.adapters.delete(name);
  }

  providerConfig(name: string): ProviderConfig {
    const base = this.settings.providers[name];
    if (!base) throw new ModelError('Unknown model provider: ' + name);
    return { ...base, ...(this.providerOverrides[name] ?? {}) };
  }

  adapterFor(providerName: string): ModelAdapter {
    const cached = this.adapters.get(providerName);
    if (cached) return cached;
    const cfg = this.providerConfig(providerName);
    if (cfg.apiKeyEndpoint && normalizeEndpoint(cfg.apiKeyEndpoint) !== normalizeEndpoint(cfg.baseUrl)) throw new ModelError('服务地址已更改，请重新输入该地址的 API Key，旧密钥不会发送到新地址。');
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
    return this.contextResolutionFor(ref).tokens;
  }
  contextResolutionFor(ref: ModelRef) { const cfg = this.providerConfig(ref.provider); return resolveContextWindow(cfg, ref.model, this.catalog.snapshot(cfg).models.find(m => m.id === ref.model)); }
  modelsFor(provider: string) { return this.catalog.snapshot(this.providerConfig(provider)); }
  refreshModels(provider: string, force = false) { const cfg = this.providerConfig(provider); return this.catalog.refresh(cfg, force || providerKind(cfg) === 'ollama'); }
  async enrichModel(provider: string, model: string) { await this.catalog.enrich(this.providerConfig(provider), model); }
  async prepare(ref: ModelRef, signal?: AbortSignal): Promise<number> {
    const cfg = this.providerConfig(ref.provider);
    if (this.options.automaticDiscovery && (apiKeyFor(cfg) || this.catalog.snapshot(cfg).source === 'api')) {
      const discovery = this.catalog.refresh(cfg, providerKind(cfg) === 'ollama', providerKind(cfg) === 'ollama' ? ref.model : undefined).then(() => this.catalog.enrich(cfg, ref.model));
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new DOMException('Interrupted', 'AbortError'));
          if (signal.aborted) { aborted(); return; }
          signal.addEventListener('abort', aborted, { once: true });
          void discovery.then(() => { signal.removeEventListener('abort', aborted); resolve(); }, err => { signal.removeEventListener('abort', aborted); reject(err); });
        });
      } else await discovery;
    }
    return this.contextWindowFor(ref);
  }

  /** Stream a request using a provider/model reference. */
  validateRequest(ref: ModelRef, req: Pick<ModelRequest, 'messages' | 'tools'>): void {
    const model = this.modelsFor(ref.provider).models.find(m => m.id === ref.model);
    if (model?.lifecycle === 'retired') throw new ModelError('该模型已下线，请切换可用模型：' + ref.model, 400);
    if (req.tools.length && (model?.tools === false || model?.unavailableReason)) throw new ModelError((model.unavailableReason ?? '此模型不支持智能体工具调用，请切换支持工具的模型') + '：' + ref.model, 400);
    if (model?.vision === false && req.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image'))) {
      throw new ModelError('当前模型不支持图片理解，本次未发出推理请求。请切换支持图片的模型；对话中的历史图片也需要图片能力：' + ref.model, 400);
    }
  }
  async *stream(ref: ModelRef, req: Omit<ModelRequest, 'model'>): AsyncIterable<ModelDelta> {
    this.validateRequest(ref, req);
    const model = this.modelsFor(ref.provider).models.find(m => m.id === ref.model);
    const adapter = this.adapterFor(ref.provider);
    const requestedOutput = req.maxOutputTokens ?? (adapter.wire === 'anthropic' ? 8192 : undefined);
    const maxOutputTokens = model?.maxOutputTokens && requestedOutput ? Math.min(requestedOutput, model.maxOutputTokens) : req.maxOutputTokens;
    yield* adapter.stream({ ...req, ...(maxOutputTokens ? { maxOutputTokens } : {}), model: ref.model });
  }
}
