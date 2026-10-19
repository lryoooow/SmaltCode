/**
 * Layered settings: built-in defaults ← user (~/.smalt/settings.json)
 * ← project (.smalt/settings.json). Later layers win.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PERMISSION_MODES, parseRule, type PermissionMode, type PermissionRule } from '../permissions/rules.js';
import { isProjectTrusted } from './trust.js';
import type { CommandHookConfig, HookEvent } from '../hooks/bus.js';
import { validContextWindow } from '../models/context-window.js';

export interface ProviderConfig {
  baseUrl: string;
  wire: 'chat' | 'anthropic';
  /** environment variable holding the API key (preferred over apiKey) */
  apiKeyEnv?: string;
  /** literal key from a local config file — never commit these */
  apiKey?: string;
  /** Credentials are valid only for this explicitly approved service endpoint. */
  apiKeyEndpoint?: string;
  contextWindow?: number;
  /** Explicit per-model limits for gateways/local models. Null restores automatic resolution. */
  modelContextWindows?: Record<string, number | null>;
  defaultModel?: string;
}

export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, ProviderConfig>;
  permissions: {
    mode: PermissionMode;
    allow: string[];
    deny: string[];
    ask: string[];
  };
  hooks: Partial<Record<HookEvent, CommandHookConfig[]>>;
  compact: {
    enabled: boolean;
    /** fraction of the context window that triggers compaction (0..1) */
    threshold: number;
    /** messages kept verbatim at the tail */
    keepMessages: number;
    maxConsecutive: number;
  };
}

export function smaltHome(): string {
  return process.env.SMALT_HOME ?? join(homedir(), '.smalt');
}

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    wire: 'chat',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    wire: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5-5',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    wire: 'chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    wire: 'chat',
    apiKeyEnv: 'ZHIPU_API_KEY',
    defaultModel: 'glm-5.3',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/v1',
    wire: 'chat',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    wire: 'chat',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen3.8-max',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    wire: 'chat',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    wire: 'chat',
    apiKey: 'ollama',
    defaultModel: 'qwen3:8b',
  },
};

function defaultSettings(): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: BUILTIN_PROVIDERS.openai!.defaultModel!,
    providers: structuredClone(BUILTIN_PROVIDERS),
    permissions: {
      mode: 'default',
      allow: [],
      deny: [],
      ask: [],
    },
    hooks: {},
    compact: {
      enabled: true,
      threshold: 0.8,
      keepMessages: 10,
      maxConsecutive: 2,
    },
  };
}

/** stricter is safer: used when merging modes across layers */
const MODE_STRICTNESS: Record<PermissionMode, number> = {
  plan: 4,
  default: 3,
  acceptEdits: 2,
  dontAsk: 1,
  bypassPermissions: 0,
};

function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

export function loadSettings(cwd: string, overrides?: { permissionMode?: PermissionMode }, userSettings?: Settings, includeProject = true): Settings {
  const settings = userSettings ? structuredClone(userSettings) : defaultSettings();

  const userFile = join(smaltHome(), 'settings.json');
  if (!userSettings && existsSync(userFile)) {
    try {
      applyLayer(settings, JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, unknown>);
    } catch (err) {
      // A broken settings file must never take the kernel down.
      process.stderr.write(
        `[smalt] ignoring invalid settings ${userFile}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  if (overrides?.permissionMode) settings.permissions.mode = overrides.permissionMode;
  const projectFile = join(cwd, '.smalt', 'settings.json');
  if (includeProject && existsSync(projectFile)) {
    try {
      const raw = JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
      if (isProjectTrusted(cwd)) {
        applyLayer(settings, raw, true);
      } else {
        // untrusted project settings may only TIGHTEN security: merge
        // deny/ask, pick the stricter mode; allow rules, providers (key
        // exfiltration via baseUrl), hooks (startup command execution) and
        // everything else from this file are ignored entirely.
        applyRestrictiveLayer(settings, raw);
      }
    } catch (err) {
      process.stderr.write(
        `[smalt] ignoring invalid project settings ${projectFile}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  return settings;
}

/** only-tightening merge for UNTRUSTED project settings */
function applyRestrictiveLayer(target: Settings, layer: Record<string, unknown>): void {
  const p = layer.permissions;
  if (!p || typeof p !== 'object') return;
  const proj = p as Record<string, unknown>;
  if (typeof proj.mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(proj.mode)) {
    target.permissions.mode = stricterMode(target.permissions.mode, proj.mode as PermissionMode);
  }
  for (const key of ['deny', 'ask'] as const) {
    if (Array.isArray(proj[key])) {
      const incoming = (proj[key] as unknown[]).filter((s): s is string => typeof s === 'string');
      target.permissions[key] = [...new Set([...target.permissions[key], ...incoming])];
    }
  }
}

function applyLayer(target: Settings, layer: Record<string, unknown>, project = false): void {
  if (typeof layer.defaultProvider === 'string') target.defaultProvider = layer.defaultProvider;
  if (typeof layer.defaultModel === 'string') target.defaultModel = layer.defaultModel;

  if (layer.providers && typeof layer.providers === 'object') {
    for (const [name, cfg] of Object.entries(layer.providers as Record<string, Record<string, unknown>>)) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (project) {
        // Project configuration never redirects a provider that owns a user key.
        if (target.providers[name]) continue;
        const used = new Set(Object.values(target.providers).map(p => p.apiKeyEnv).filter(Boolean));
        if (typeof cfg.apiKeyEnv !== 'string' || used.has(cfg.apiKeyEnv) || typeof cfg.apiKey === 'string' || 'apiKeyEnc' in cfg) continue;
      }
      const existing = target.providers[name] ?? {};
      target.providers[name] = {
        ...existing,
        ...(typeof cfg.baseUrl === 'string' ? { baseUrl: cfg.baseUrl } : {}),
        ...(typeof cfg.wire === 'string' && (cfg.wire === 'chat' || cfg.wire === 'anthropic') ? { wire: cfg.wire } : {}),
        ...(typeof cfg.apiKeyEnv === 'string' ? { apiKeyEnv: cfg.apiKeyEnv } : {}),
        ...(typeof cfg.apiKey === 'string' ? { apiKey: cfg.apiKey } : {}),
        ...(!project && typeof cfg.apiKeyEnc === 'string' ? { apiKeyEnc: cfg.apiKeyEnc } : {}),
        ...(!project && typeof cfg.apiKeyEndpoint === 'string' ? { apiKeyEndpoint: cfg.apiKeyEndpoint } : {}),
        ...(validContextWindow(cfg.contextWindow) ? { contextWindow: cfg.contextWindow } : cfg.contextWindow === null ? { contextWindow: undefined } : {}),
        ...(cfg.modelContextWindows && typeof cfg.modelContextWindows === 'object' && !Array.isArray(cfg.modelContextWindows) ? { modelContextWindows: { ...existing.modelContextWindows, ...Object.fromEntries(Object.entries(cfg.modelContextWindows).filter(([name, value]) => name.length > 0 && name.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(name) && (value === null || validContextWindow(value)))) } } : {}),
        ...(typeof cfg.defaultModel === 'string' ? { defaultModel: cfg.defaultModel } : {}),
      };
    }
  }

  if (layer.permissions && typeof layer.permissions === 'object') {
    const p = layer.permissions as Record<string, unknown>;
    if (typeof p.mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(p.mode)) {
      target.permissions.mode = p.mode as PermissionMode;
    }
    for (const key of ['allow', 'deny', 'ask'] as const) {
      if (Array.isArray(p[key])) {
        // rules MERGE across layers (never wipe a deny list set elsewhere)
        const incoming = (p[key] as unknown[]).filter((s): s is string => typeof s === 'string');
        target.permissions[key] = [...new Set([...target.permissions[key], ...incoming])];
      }
    }
  }

  if (layer.hooks && typeof layer.hooks === 'object') {
    for (const [event, list] of Object.entries(layer.hooks as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const configs: CommandHookConfig[] = [];
      for (const item of list) {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).command === 'string') {
          const rec = item as Record<string, unknown>;
          configs.push({
            command: rec.command as string,
            ...(typeof rec.timeoutMs === 'number' ? { timeoutMs: rec.timeoutMs } : {}),
          });
        }
      }
      if (configs.length) target.hooks[event as HookEvent] = configs;
    }
  }

  if (layer.compact && typeof layer.compact === 'object') {
    const c = layer.compact as Record<string, unknown>;
    if (typeof c.enabled === 'boolean') target.compact.enabled = c.enabled;
    if (typeof c.threshold === 'number' && Number.isFinite(c.threshold)) target.compact.threshold = Math.min(0.98, Math.max(0.3, c.threshold));
    if (typeof c.keepMessages === 'number' && Number.isFinite(c.keepMessages)) target.compact.keepMessages = Math.max(2, Math.round(c.keepMessages));
    if (typeof c.maxConsecutive === 'number' && Number.isFinite(c.maxConsecutive)) target.compact.maxConsecutive = Math.max(1, Math.round(c.maxConsecutive));
  }
}

export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Resolve a model reference like "deepseek/deepseek-chat" or a bare
 * "deepseek-chat" (uses the default provider).
 */
export function resolveModelRef(ref: string | undefined, settings: Settings): ModelRef {
  if (ref && ref.includes('/')) {
    const slash = ref.indexOf('/');
    const provider = ref.slice(0, slash);
    const model = ref.slice(slash + 1);
    if (settings.providers[provider]) return { provider, model: model || defaultModelOf(settings, provider) };
    // OpenRouter-style refs ("openai/gpt-4o") with a provider that is itself a
    // path: try the longest provider prefix match
    return { provider: settings.defaultProvider, model: ref };
  }
  if (ref) return { provider: settings.defaultProvider, model: ref };
  return {
    provider: settings.defaultProvider,
    model: settings.defaultModel || defaultModelOf(settings, settings.defaultProvider),
  };
}

function defaultModelOf(settings: Settings, provider: string): string {
  return settings.providers[provider]?.defaultModel ?? 'gpt-4o-mini';
}

export function apiKeyFor(provider: ProviderConfig): string | undefined {
  if (provider.apiKeyEndpoint && normalizeEndpoint(provider.baseUrl) !== normalizeEndpoint(provider.apiKeyEndpoint)) return undefined;
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return process.env[provider.apiKeyEnv];
  return provider.apiKey;
}

export function normalizeEndpoint(value: string): string { return value.replace(/\/+$/, ''); }

/** Absolute-path helper for tools: input paths are resolved against cwd. */
/**
 * Merge a patch into ~/.smalt/settings.json and return freshly loaded
 * settings. Used by hosts with a settings UI.
 */
export function updateUserSettingsFile(
  cwd: string,
  patch: Record<string, unknown>,
  includeProject = true,
): Settings {
  const file = join(smaltHome(), 'settings.json');
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      data = {};
    }
  } else {
    mkdirSync(smaltHome(), { recursive: true });
  }
  deepMerge(data, patch);
  const temporary = file + '.tmp';
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
  return loadSettings(cwd, undefined, undefined, includeProject);
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = (typeof target[key] === 'object' && target[key] && !Array.isArray(target[key])
        ? target[key]
        : {}) as Record<string, unknown>;
      target[key] = existing;
      deepMerge(existing, value as Record<string, unknown>);
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const abs = isAbsolute(normalized) ? normalized : join(cwd.replace(/\\/g, '/'), normalized);
  return abs;
}
