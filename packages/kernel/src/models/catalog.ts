import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiKeyFor, normalizeEndpoint, type ProviderConfig } from '../config/settings.js';
import { validContextWindow } from './context-window.js';
import { officialModel, officialModels, providerKind, type ModelInfo } from './profiles.js';

export type CatalogResult = { models: ModelInfo[]; source: 'api' | 'official' | 'none'; checkedAt?: number; stale: boolean; error?: string; truncated?: boolean; revision?: number };
type Entry = { models: ModelInfo[]; checkedAt: number; truncated?: boolean; source?: 'api' | 'official' };
const TTL = 6 * 60 * 60 * 1000, MAX_AGE = 7 * 24 * 60 * 60 * 1000, MAX_BYTES = 4 * 1024 * 1024;
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const string = (v: unknown, max = 256): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : undefined;
const limit = (v: unknown): number | undefined => validContextWindow(v) && v <= 100_000_000 ? v : undefined;
function smallest(...values: unknown[]): number | undefined { const all = values.map(limit).filter((v): v is number => !!v); return all.length ? Math.min(...all) : undefined; }

export function parseModel(value: unknown, config: ProviderConfig): ModelInfo | undefined {
  const raw = record(value), id = string(raw.id) ?? string(raw.model) ?? string(raw.name);
  if (!id) return;
  const profile = officialModel(config, id);
  const architecture = record(raw.architecture), top = record(raw.top_provider), limits = record(raw.limits), capabilities = record(raw.capabilities);
  const input = Array.isArray(raw.input_modalities) ? raw.input_modalities : architecture.input_modalities;
  const output = Array.isArray(raw.output_modalities) ? raw.output_modalities : architecture.output_modalities;
  const parameters = raw.supported_parameters;
  let tools = typeof raw.supports_tools === 'boolean' ? raw.supports_tools : Array.isArray(parameters) ? parameters.includes('tools') : undefined;
  if (Array.isArray(output) && !output.includes('text')) tools = false;
  if (tools === undefined && /^(?:text-embedding|embedding-|whisper|tts-|dall-e|gpt-image|omni-moderation)|(?:^|\/)(?:rerank|cogview|cogvideo)/i.test(id)) tools = false;
  const lifecycle = ['active', 'deprecated', 'retired'].includes(raw.lifecycle) ? raw.lifecycle : raw.shutdown_date && Date.parse(raw.shutdown_date) <= Date.now() ? 'retired' : undefined;
  const contextWindow = smallest(raw.context_window, raw.context_length, raw.max_model_len, limits.context_window, top.context_length);
  const maxInputTokens = smallest(raw.max_input_tokens, limits.max_input_tokens);
  const created = typeof raw.created === 'number' ? raw.created * 1000 : Date.parse(raw.created_at ?? '');
  return {
    ...profile, id, name: string(raw.display_name) ?? string(raw.name) ?? profile?.name ?? id,
    ...(contextWindow ? { contextWindow } : {}), ...(maxInputTokens ? { maxInputTokens } : {}),
    ...(limit(raw.max_output_tokens ?? raw.max_tokens ?? top.max_completion_tokens) ? { maxOutputTokens: limit(raw.max_output_tokens ?? raw.max_tokens ?? top.max_completion_tokens) } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(Array.isArray(input) ? { vision: input.includes('image') } : typeof capabilities.image_input?.supported === 'boolean' ? { vision: capabilities.image_input.supported } : {}),
    ...(Number.isFinite(created) && created > 0 ? { createdAt: created } : {}), ...(lifecycle ? { lifecycle } : {}),
    source: contextWindow || maxInputTokens ? 'api' : profile?.contextWindow ? 'official' : 'api',
    ...(providerKind(config) === 'openai' && /^(?:openai(?:-[a-z0-9-]+)?|system)$/.test(raw.owned_by ?? '') && /^(?:gpt-[a-z0-9.-]+|o[134](?:-[a-z0-9-]+)?)$/.test(id) ? { publicDocs: true } : {}),
    unavailableReason: lifecycle === 'retired' ? '服务商已下线此模型' : tools === false ? '此模型不支持当前智能体所需的文本工具调用' : profile?.unavailableReason,
  };
}

/** Account/endpoint-bound metadata, no prompts or generation requests. */
export class ModelCatalog {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<CatalogResult>>();
  private failures = new Map<string, { at: number; message: string }>();
  private detailRequests = new Map<string, Promise<void>>();
  private detailFailures = new Map<string, number>();
  private revision = 0;
  constructor(private readonly options: { file?: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    try {
      if (!options.file || !existsSync(options.file) || statSync(options.file).size > MAX_BYTES) return;
      const data = JSON.parse(readFileSync(options.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries)) return;
      for (const [key, entry] of data.entries.slice(-32)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || !Number.isFinite(entry.checkedAt) || !Array.isArray(entry.models) || entry.models.length > 2000) continue;
        const models = entry.models.filter((m: ModelInfo) => string(m?.id) && string(m?.name) && ['api', 'official'].includes(m.source) && (!m.contextWindow || limit(m.contextWindow)) && (!m.maxInputTokens || limit(m.maxInputTokens)));
        this.entries.set(key, { checkedAt: Math.min(entry.checkedAt, this.now()), models, truncated: entry.truncated === true, source: entry.source === 'official' ? 'official' : 'api' });
      }
    } catch { /* A corrupt metadata cache cannot prevent startup. */ }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private key(config: ProviderConfig) { return createHash('sha256').update(JSON.stringify([normalizeEndpoint(config.baseUrl), config.wire, apiKeyFor(config) ?? ''])).digest('hex'); }
  snapshot(config: ProviderConfig): CatalogResult {
    const key = this.key(config), entry = this.entries.get(key), age = entry ? this.now() - entry.checkedAt : Infinity;
    const cached = entry && age <= MAX_AGE ? entry : undefined;
    return { models: cached ? cached.models.map(m => ({ ...m })) : officialModels(config), source: cached ? cached.source ?? 'api' : officialModels(config).length ? 'official' : 'none', checkedAt: cached?.checkedAt, stale: age > TTL || this.failures.has(key), error: this.failures.get(key)?.message, truncated: cached?.truncated, revision: this.revision };
  }
  async refresh(config: ProviderConfig, force = false, detailModel?: string): Promise<CatalogResult> {
    const key = this.key(config), snapshot = this.snapshot(config);
    if (!force && snapshot.checkedAt !== undefined && !snapshot.stale) return snapshot;
    if (!force && this.now() - (this.failures.get(key)?.at ?? -Infinity) < 60_000) return snapshot;
    const inFlight = this.pending.get(key); if (inFlight) return inFlight;
    const task = this.fetch(config, detailModel).catch(async error => {
      const url = officialCatalogURL(config);
      if (!(error instanceof CatalogError) || ![404, 405, 501].includes(error.status ?? 0) || !url) throw error;
      try {
        const text = await this.publicText(url, 512 * 1024);
        const models = parseOfficialCatalog(text, config, url);
        if (!models.length) throw new Error('unknown official catalog format');
        return { models, checkedAt: this.now(), source: 'official' as const };
      } catch { throw error; }
    }).then(entry => {
      const previous = this.entries.get(key);
      for (const model of entry.models) {
        const before = previous?.models.find(m => m.id === model.id);
        if (before?.verifiedAt && this.now() - before.verifiedAt < MAX_AGE && !(model.source === 'api' && (model.contextWindow || model.maxInputTokens))) {
          for (const field of ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'verifiedAt', 'reference'] as const) if (before[field] !== undefined) (model as any)[field] = before[field];
          model.source = 'official';
        }
      }
      this.entries.delete(key); this.entries.set(key, entry); this.failures.delete(key);
      this.revision++;
      while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
      this.save(); return this.snapshot(config);
    }).catch((error: unknown) => {
      const message = error instanceof CatalogError ? error.message : '模型列表获取失败，请检查网络连接后重试';
      this.failures.set(key, { at: this.now(), message }); this.revision++; return this.snapshot(config);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
  /** OpenAI's model list omits token limits. Read only public, vendor-owned
   * model cards, using a separate request which never carries API credentials. */
  async enrich(config: ProviderConfig, id: string): Promise<void> {
    const key = this.key(config), entry = this.entries.get(key), model = entry?.models.find(m => m.id === id);
    if (providerKind(config) !== 'openai' || !model?.publicDocs || model.lifecycle === 'retired' || model.source === 'api' && (model.contextWindow || model.maxInputTokens) || model.verifiedAt && this.now() - model.verifiedAt < TTL) return;
    const detailKey = key + ':' + id;
    if (this.now() - (this.detailFailures.get(detailKey) ?? -Infinity) < 60_000) return;
    const pending = this.detailRequests.get(detailKey); if (pending) return pending;
    const task = (async () => {
      try {
        const url = 'https://developers.openai.com/api/docs/models/' + encodeURIComponent(id) + '.md';
        const limits = modelCardLimits(await this.publicText(url, 256 * 1024));
        if (!limits.contextWindow) throw new Error('unknown model-card format');
        // The account or endpoint may have changed while this request ran.
        const current = this.entries.get(key)?.models.find(m => m.id === id); if (!current) return;
        Object.assign(current, Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)), { source: 'official', reference: url, verifiedAt: this.now() }); this.revision++; this.save();
      } catch { this.detailFailures.set(detailKey, this.now()); }
    })().finally(() => this.detailRequests.delete(detailKey));
    this.detailRequests.set(detailKey, task); return task;
  }
  private async publicText(url: string, maxBytes: number) {
    const res = await (this.options.fetchImpl ?? fetch)(url, { redirect: 'error', headers: { accept: 'text/markdown, text/plain;q=0.9' }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000) });
    if (!res.ok || !res.body || Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel(); throw new Error('official document unavailable'); }
    const reader = res.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maxBytes) throw new Error('official document too large'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }
  private save() {
    if (!this.options.file) return;
    try {
      const text = JSON.stringify({ version: 1, entries: [...this.entries] }); if (Buffer.byteLength(text) > MAX_BYTES) return;
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileSync(this.options.file + '.tmp', text, { mode: 0o600 }); renameSync(this.options.file + '.tmp', this.options.file);
    } catch { /* The in-memory result remains usable on disk errors. */ }
  }
  private async fetch(config: ProviderConfig, detailModel?: string): Promise<Entry> {
    const base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash || base.search) throw new CatalogError('服务地址无效，请先保存正确的服务配置');
    if (config.apiKeyEndpoint && normalizeEndpoint(config.apiKeyEndpoint) !== normalizeEndpoint(config.baseUrl)) throw new CatalogError('服务地址已变化，请为新地址重新填写密钥');
    const kind = providerKind(config), key = apiKeyFor(config);
    if (!key && kind !== 'ollama') throw new CatalogError('请先保存该服务商的 API Key，再获取模型列表');
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 6000);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (key && kind !== 'ollama') {
      if (config.wire === 'anthropic' && kind !== 'deepseek') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      else headers.authorization = 'Bearer ' + key;
    }
    let totalBytes = 0;
    const json = async (url: URL, body?: object) => {
      if (url.origin !== base.origin) throw new CatalogError('模型发现不允许跨服务地址跳转');
      const response = await (this.options.fetchImpl ?? fetch)(url, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new CatalogError(response.status === 401 || response.status === 403 ? `模型列表访问被拒绝（HTTP ${response.status}），请检查密钥及模型列表权限` : response.status === 404 || response.status === 405 ? '此服务未提供兼容的模型列表接口，可选择内置目录或填写模型 ID' : `模型列表请求失败（HTTP ${response.status}）`, response.status); }
      if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) { await response.body?.cancel(); throw new CatalogError('模型列表响应为空或超过大小限制'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; totalBytes += value.byteLength; if (totalBytes > MAX_BYTES) throw new CatalogError('模型列表响应超过 4 MB 限制'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new CatalogError('服务返回的模型列表不是有效 JSON'); }
    };
    const url = new URL(normalizeEndpoint(config.baseUrl) + (config.wire === 'anthropic' && !base.pathname.replace(/\/$/, '').endsWith('/v1') ? '/v1/models' : '/models'));
    if (kind === 'deepseek') { url.pathname = '/models'; url.search = ''; }
    if (kind === 'openrouter') url.pathname = '/api/v1/models/user';
    // Ollama's active allocation, not the GGUF theoretical maximum, determines
    // how much context OpenAI-compatible requests can actually use.
    if (kind === 'ollama') {
      const data = await json(new URL('/api/tags', base));
      if (!Array.isArray(data.models)) throw new CatalogError('Ollama 未返回模型列表');
      let running: any[] = [];
      try { const active = await json(new URL('/api/ps', base)); if (Array.isArray(active.models)) running = active.models; } catch { /* /ps is optional on older versions. */ }
      const models: ModelInfo[] = data.models.slice(0, 2000).flatMap((raw: unknown) => {
        const model = parseModel(raw, config); if (!model) return [];
        const active = running.find(m => m.name === model.id || m.model === model.id);
        return [{ ...model, contextWindow: limit(active?.context_length), source: 'api' as const }];
      });
      const target = models.find(m => m.id === detailModel);
      if (target) try {
        const details = record(await json(new URL('/api/show', base), { model: target.id }));
        if (!target.contextWindow) target.contextWindow = limit(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(details.parameters ?? '')?.[1]));
        if (Array.isArray(details.capabilities)) { target.tools = details.capabilities.includes('tools'); target.vision = details.capabilities.includes('vision'); if (!target.tools) target.unavailableReason = '此本地模型未声明工具调用能力'; }
      } catch { /* Retain an active allocation or the explicitly unknown fallback. */ }
      return { checkedAt: this.now(), models, truncated: data.models.length > 2000 };
    }
    const all = new Map<string, ModelInfo>(); let truncated = false;
    if (config.wire === 'anthropic') url.searchParams.set('limit', '1000');
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const data = record(await json(url));
      if (!Array.isArray(data.data)) throw new CatalogError('服务未返回兼容的模型列表 data 数组', 405);
      for (const [index, raw] of data.data.entries()) { const model = parseModel(raw, config); if (model) all.set(model.id, model); if (all.size >= 2000) { truncated ||= index < data.data.length - 1; break; } }
      if (!data.has_more) break;
      const next = string(data.last_id); if (config.wire !== 'anthropic' || !next || cursors.has(next) || page === 9 || all.size >= 2000) { truncated = true; break; }
      cursors.add(next); url.searchParams.set('after_id', next);
    }
    const models = [...all.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id));
    return { models, checkedAt: this.now(), truncated };
  }
}
class CatalogError extends Error { constructor(message: string, readonly status?: number) { super(message); } }

function officialCatalogURL(config: ProviderConfig): string | undefined {
  return ({ zhipu: 'https://docs.bigmodel.cn/cn/guide/start/model-overview.md', moonshot: 'https://platform.kimi.com/docs/models.md', dashscope: 'https://www.alibabacloud.com/help/en/model-studio/text-generation-model/' } as Record<string, string>)[providerKind(config)];
}

/** Extract exact model IDs and explicitly stated context cells, never prose
 * instructions, arbitrary links, guessed version ranges or output-token cells. */
export function parseOfficialCatalog(text: string, config: ProviderConfig, reference: string): ModelInfo[] {
  const plain = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<tr\b[^>]*>/gi, '\n|').replace(/<\/tr>/gi, '|\n').replace(/<\/(?:td|th)>/gi, '|').replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/&nbsp;/g, ' ');
  const models = new Map<string, ModelInfo>(); let contextColumn = -1, toolsColumn = -1, retired = false;
  const number = (text: string) => { const m = /(\d[\d,]*(?:\.\d+)?)\s*(K|M|万)\b/i.exec(text) ?? /(\d[\d,]*(?:\.\d+)?)\s*(万)/.exec(text); return m ? limit(Number(m[1]!.replace(/,/g, '')) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2] === '万' ? 10000 : 1000)) : undefined; };
  for (const line of plain.split('\n')) {
    if (/^\s*#{1,4}\s/.test(line)) { retired = /已下线|retired/i.test(line); contextColumn = -1; toolsColumn = -1; }
    if (!line.includes('|')) continue;
    const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.replace(/`|\*/g, '').trim());
    if (cells.some(c => /^(?:上下文|上下文窗口|context(?: window)?)$/i.test(c))) { contextColumn = cells.findIndex(c => /^(?:上下文|上下文窗口|context(?: window)?)$/i.test(c)); toolsColumn = cells.findIndex(c => /^(?:function calling|工具调用)$/i.test(c)); continue; }
    const ids = cells[0]?.match(/\b(?:glm-|qwen|kimi-|moonshot-|deepseek-)[a-z0-9_.-]+/gi) ?? [];
    for (const rawID of ids) {
      const id = rawID.toLowerCase(); if (!string(id) || models.size >= 2000) continue;
      const fromCell = contextColumn >= 0 ? number(cells[contextColumn] ?? '') : undefined;
      const described = /(?:上下文(?:窗口)?\D{0,8}(\d[\d,.]*\s*(?:K|M|万))|(\d[\d,.]*\s*(?:K|M|万))\s*(?:tokens?\s*)?上下文)/i.exec(cells.slice(1).join(' '));
      const contextWindow = fromCell ?? (described ? number(described[1] ?? described[2] ?? '') : undefined);
      const profile = officialModel(config, id);
      if (!contextWindow && !profile && !retired) continue;
      const info: ModelInfo = { ...profile, id, name: profile?.name ?? rawID, source: 'official', reference, ...(contextWindow ? { contextWindow } : {}), ...(retired || /已下线/.test(cells.slice(1).join(' ')) ? { lifecycle: 'retired', unavailableReason: '官方已下线此模型' } : {}) };
      if (/^(?:unsupported|不支持|false|no)$/i.test(cells[toolsColumn] ?? '')) { info.tools = false; info.unavailableReason = '官方目录标明此模型不支持工具调用'; }
      else if (/^(?:supported|支持|true|yes)$/i.test(cells[toolsColumn] ?? '')) info.tools = true;
      models.set(id, info);
    }
  }
  return [...models.values()];
}

export function modelCardLimits(text: string): Pick<ModelInfo, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'> {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\*|`/g, '');
  const tokens = (label: string) => {
    const value = new RegExp(label + '[\\s:|–-]*([0-9][\\d,]*(?:\\.\\d+)?)\\s*([kKmM])?(?:\\s*(?:tokens?|Token))?', 'i').exec(plain);
    if (!value) return undefined;
    return limit(Number(value[1]!.replace(/,/g, '')) * (value[2]?.toLowerCase() === 'm' ? 1_000_000 : value[2]?.toLowerCase() === 'k' ? 1000 : 1));
  };
  return { contextWindow: tokens('context window'), maxInputTokens: tokens('max input'), maxOutputTokens: tokens('max output') };
}
