import type { ProviderConfig } from '../config/settings.js';

export type ModelInfo = {
  id: string; name: string; contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number;
  tools?: boolean; vision?: boolean; createdAt?: number; lifecycle?: 'active' | 'deprecated' | 'retired';
  source: 'api' | 'official'; reference?: string; unavailableReason?: string;
  publicDocs?: boolean; verifiedAt?: number;
};
export type ProviderKind = 'openai' | 'anthropic' | 'deepseek' | 'zhipu' | 'moonshot' | 'dashscope' | 'openrouter' | 'ollama' | 'custom';

/** Limits belong to a serving endpoint, not a model-name substring. */
export function providerKind(config: Pick<ProviderConfig, 'baseUrl' | 'wire'>): ProviderKind {
  try {
    const url = new URL(config.baseUrl);
    if (url.username || url.password || url.search || url.hash) return 'custom';
    const path = url.pathname.replace(/\/+$/, '');
    if (url.port === '11434' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['', '/v1'].includes(path)) return 'ollama';
    if (url.protocol !== 'https:' || url.port) return 'custom';
    if (url.hostname === 'api.openai.com' && path === '/v1') return 'openai';
    if (url.hostname === 'api.anthropic.com' && ['', '/v1'].includes(path)) return 'anthropic';
    if (url.hostname === 'api.deepseek.com' && ['', '/v1', '/anthropic'].includes(path)) return 'deepseek';
    if (url.hostname === 'open.bigmodel.cn' && ['/api/paas/v4', '/api/coding/paas/v4', '/api/anthropic', '/api/anthropic/coding'].includes(path)) return 'zhipu';
    if (['api.moonshot.cn', 'api.moonshot.ai'].includes(url.hostname) && path === '/v1') return 'moonshot';
    if ((['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com'].includes(url.hostname) || /^[a-z0-9-]+\.(?:cn-beijing|cn-hongkong|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(url.hostname)) && path === '/compatible-mode/v1') return 'dashscope';
    if (url.hostname === 'openrouter.ai' && path === '/api/v1') return 'openrouter';
  } catch { /* Invalid URLs fail at the request boundary. */ }
  return 'custom';
}

// Official documentation checked 2026-10-19. API discovery can supersede these
// snapshots; aliases are exact IDs, never extrapolated to unknown future models.
const profiles: Partial<Record<ProviderKind, ModelInfo[]>> = {};
function add(kind: ProviderKind, ids: string[], window: number, reference: string, extra: Partial<ModelInfo> = {}) {
  (profiles[kind] ??= []).push(...ids.map(id => ({ id, name: id, contextWindow: window, tools: true, source: 'official' as const, reference, ...extra })));
}
const oa = 'https://developers.openai.com/api/docs/models/';
for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) add('openai', [id], 1_050_000, oa + id, { maxInputTokens: 922_000, maxOutputTokens: 128_000, vision: true, ...(id === 'gpt-6-astra' ? {} : { unavailableReason: id === 'gpt-6.1-sol' ? '该模型的智能体工具调用需要 Responses 协议；当前连接使用 Chat Completions' : '当前连接尚未适配此型号的工具调用模式' }) });
add('openai', ['gpt-5.4'], 1_050_000, oa + 'gpt-5.4', { maxOutputTokens: 128_000, vision: true });
add('openai', ['gpt-4.1'], 1_047_576, oa + 'gpt-4.1', { maxOutputTokens: 32_768, vision: true });
add('openai', ['gpt-4o-mini'], 128_000, oa + 'gpt-4o-mini', { maxOutputTokens: 16_384, vision: true });
for (const id of ['gpt-5.5']) add('openai', [id], 1_050_000, oa + id, { maxOutputTokens: 128_000, vision: true });
for (const id of ['gpt-5.2', 'gpt-5.1']) add('openai', [id], 400_000, oa + id, { maxOutputTokens: 128_000, vision: true });
for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.4-mini']) add('openai', [id], 400_000, oa + id, { maxInputTokens: 272_000, maxOutputTokens: 128_000, vision: true });
for (const id of ['gpt-4.1-mini', 'gpt-4.1-nano']) add('openai', [id], 1_047_576, oa + id, { maxOutputTokens: 32_768, vision: true });
add('openai', ['gpt-4o'], 128_000, oa + 'gpt-4o', { maxOutputTokens: 16_384, vision: true });
for (const id of ['o3', 'o4-mini']) add('openai', [id], 200_000, oa + id, { maxOutputTokens: 100_000, vision: true });
add('openai', ['gpt-5.3-codex'], 400_000, oa + 'gpt-5.3-codex', { maxInputTokens: 272_000, maxOutputTokens: 128_000, unavailableReason: '该模型需要 Responses 协议；当前连接使用 Chat Completions' });
add('anthropic', ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], 1_000_000, 'https://platform.claude.com/docs/en/models/overview', { maxOutputTokens: 128_000, vision: true });
add('deepseek', ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], 1_000_000, 'https://api-docs.deepseek.com/quick_start/pricing/');
add('zhipu', ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-4-long'], 1_000_000, 'https://docs.bigmodel.cn/cn/guide/start/model-overview');
add('zhipu', ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6'], 200_000, 'https://docs.bigmodel.cn/cn/guide/start/model-overview');
add('zhipu', ['glm-4.5-air', 'glm-4.5-airx', 'glm-4.5-flash'], 128_000, 'https://docs.bigmodel.cn/cn/guide/start/model-overview');
add('moonshot', ['kimi-k3'], 1_000_000, 'https://platform.kimi.com/docs/models', { vision: true });
add('moonshot', ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'], 256_000, 'https://platform.kimi.com/docs/models', { vision: true });
for (const id of ['kimi-k2.5', 'kimi-k2-0905-preview', 'kimi-k2-0711-preview', 'kimi-k2-turbo-preview', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'moonshot-v1-auto', 'kimi-latest']) (profiles.moonshot ??= []).push({ id, name: id, lifecycle: 'retired', source: 'official', reference: 'https://platform.kimi.com/docs/models', unavailableReason: '官方已下线，请选择当前模型' });
add('dashscope', ['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3-coder-plus', 'qwen3-coder-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'], 1_000_000, 'https://www.alibabacloud.com/help/en/model-studio/text-generation-model/');
add('dashscope', ['qwen3.6-max-preview', 'qwen3-coder-next', 'kimi-k2.6'], 256_000, 'https://www.alibabacloud.com/help/en/model-studio/text-generation-model/');
add('dashscope', ['qwen-max', 'qwen-max-2025-01-25'], 32_768, 'https://help.aliyun.com/zh/model-studio/qwen-max', { maxInputTokens: 30_720, maxOutputTokens: 8192 });

export function officialModels(config: Pick<ProviderConfig, 'baseUrl' | 'wire'>): ModelInfo[] {
  return (profiles[providerKind(config)] ?? []).map(info => ({ ...info, ...(info.id.startsWith('qwen-max') && new URL(config.baseUrl).hostname === 'dashscope-intl.aliyuncs.com' ? { tools: false, unavailableReason: '此地区的旧版 Qwen-Max 不支持 Function Calling，请选择当前模型' } : {}) }));
}
export function officialModel(config: Pick<ProviderConfig, 'baseUrl' | 'wire'>, id: string): ModelInfo | undefined { return officialModels(config).find(info => info.id === id); }
