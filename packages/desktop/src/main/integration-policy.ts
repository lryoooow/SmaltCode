import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { browserURL } from './browser-policy.js';
import type { McpConfig, PluginManifest, McpTool } from '../shared/integrations.js';
import { parseSkill } from './skills.js';

export const integrationDigest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const integrationCwd = (cwd: string) => process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function integrationURL(value: unknown) { const url = browserURL(value); if (url.hash || url.search) throw new Error('服务和认证地址不能带查询参数或片段；凭据请单独填写'); return url; }
export function mcpConfig(value: unknown, cwd: string): McpConfig {
  const v = value as McpConfig;
  if (!v || !text(v.name, 80) || !['http', 'stdio'].includes(v.transport) || !['auto', 'legacy'].includes(v.protocol) || !['none', 'bearer', 'oauth', 'env'].includes(v.auth)) throw new Error('服务名称、连接方式或认证配置无效');
  const result: McpConfig = { name: v.name, transport: v.transport, cwd: resolve(cwd), protocol: v.protocol, auth: v.auth };
  if (v.transport === 'http') { result.url = integrationURL(v.url).href; if (v.auth === 'env') throw new Error('环境变量认证仅用于本机 stdio'); }
  else {
    if (!text(v.program, 2048) || !Array.isArray(v.args) || v.args.length > 64 || v.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\x00\r\n]/.test(arg))) throw new Error('请提供本机程序与 JSON 参数数组，最多 64 项');
    if (v.auth !== 'none' && v.auth !== 'env') throw new Error('stdio 使用显式环境变量，不使用 HTTP 认证');
    if (v.args.some(arg => /(?:^--?(?:token|api[-_]?key|secret|password)(?:=|$)|\bBearer\s|\bsk-[a-z0-9]{16})/i.test(arg))) throw new Error('请用单独的环境变量凭据输入框传递密钥，不要写入程序参数');
    if (/(?:^|[\\/])(?:npx|uvx)(?:\.cmd|\.exe)?$/i.test(v.program!) && !v.args.some(arg => /@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(arg) || /==\d+\.\d+(?:\.\d+)?$/.test(arg))) throw new Error('临时包执行器必须明确固定依赖版本；不要使用 latest 或无版本安装');
    result.program = v.program; result.args = [...v.args];
    if (v.envNames !== undefined && (!Array.isArray(v.envNames) || v.envNames.length > 16 || new Set(v.envNames).size !== v.envNames.length || v.envNames.some(name => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|NODE_OPTIONS|NODE_PATH|ELECTRON_|SMALT_|LD_|DYLD_|PYTHONPATH|PYTHONHOME)/i.test(name)))) throw new Error('环境变量名称无效或会修改运行时加载行为');
    result.envNames = v.envNames ?? [];
  }
  if (v.clientId !== undefined) { if (!text(v.clientId, 512)) throw new Error('OAuth 客户端 ID 无效'); result.clientId = v.clientId; }
  return result;
}
export function pluginManifest(raw: string): PluginManifest {
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('插件清单超过 128 KB');
  const value = JSON.parse(raw) as PluginManifest;
  if (!value || value.format !== 'smalt-plugin/1' || !/^[a-z][a-z0-9.-]{2,79}$/.test(value.id) || !text(value.name, 80) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version) || !text(value.description, 2000)) throw new Error('插件清单需要 smalt-plugin/1、稳定 ID、名称、明确版本和说明');
  if (!Array.isArray(value.services) || value.services.length > 8 || !value.services.length && !value.skills?.length) throw new Error('插件最多包含 8 项 MCP 服务，且不能是空插件');
  const services = value.services.map(service => { const { cwd: _cwd, ...config } = mcpConfig(service, process.cwd()); return config; });
  if (value.author !== undefined && !text(value.author, 200)) throw new Error('插件作者无效');
  if (value.homepage !== undefined) integrationURL(value.homepage);
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 24 || value.dependencies.some(dep => !dep || !text(dep.name, 160) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(dep.version) || dep.source !== undefined && !text(dep.source, 1024)))) throw new Error('依赖必须逐项声明准确版本，最多 24 项');
  if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length > 8)) throw new Error('插件最多包含 8 项技能');
  const skills = value.skills?.map(skill => parseSkill(skill, 'manual', '插件清单').text);
  return { format: value.format, id: value.id, name: value.name, version: value.version, description: value.description, ...(value.author ? { author: value.author } : {}), ...(value.homepage ? { homepage: value.homepage } : {}), dependencies: value.dependencies ?? [], services, skills: skills ?? [] };
}

/** Bounded local schemas only. Unsafe/unsupported schemas stay disabled rather than being weakened. */
export function boundedSchema(schema: any) {
  if (!schema || schema.type !== 'object' || Buffer.byteLength(JSON.stringify(schema)) > 24 * 1024) throw new Error('工具参数必须是有界的 JSON 对象 Schema');
  let nodes = 0;
  const inspect = (value: unknown, depth: number) => {
    if (++nodes > 2000 || depth > 16) throw new Error('工具 Schema 结构过深或过大');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length > 128 || !Array.isArray(value) && Object.keys(value).length > 100) throw new Error('工具 Schema 分支过多');
    for (const [key, child] of Object.entries(value)) { if (['$ref', '$dynamicRef', '$recursiveRef', 'pattern', 'patternProperties', 'format', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('此 Schema 的引用、正则或扩展未开放；工具保持停用'); inspect(child, depth + 1); }
  };
  inspect(schema, 0);
  const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false, loopEnum: 20, loopRequired: 20 });
  const validate = ajv.compile(schema);
  return (value: unknown) => validate(value) ? undefined : ajv.errorsText(validate.errors).slice(0, 500);
}
export function discoverTool(raw: unknown): { tool: McpTool; validate: (value: unknown) => string | undefined } {
  const v = raw as Record<string, any>;
  if (!v || !text(v.name, 128) || typeof v.description !== 'undefined' && !text(v.description, 8000)) throw new Error('工具名称或说明无效');
  const schema = v.inputSchema, validate = boundedSchema(schema);
  if (v.outputSchema) boundedSchema(v.outputSchema);
  const ui = v._meta?.ui?.resourceUri;
  if (ui !== undefined && (typeof ui !== 'string' || ui.length > 2048 || !ui.startsWith('ui://'))) throw new Error('交互资源地址无效');
  const digest = integrationDigest({ name: v.name, description: v.description ?? '', schema, outputSchema: v.outputSchema, ui });
  return { tool: { name: v.name, description: v.description ?? '', schema, digest, enabled: false, readOnlyClaim: v.annotations?.readOnlyHint === true, ui }, validate };
}
