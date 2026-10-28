import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isInsideWorkspace, isSensitivePath } from '@smalt/kernel';
import { integrationDigest } from './integration-policy.js';
import type { Budget, GoalConfig, MemoryConfig, ScheduleConfig, ScheduleTiming, Scope } from '../shared/autonomy.js';
export const autonomyDigest = integrationDigest;
export const canonical = (cwd: string) => { const path = realpathSync(cwd); return process.platform === 'win32' ? path.toLowerCase() : path; };
export const boundText = (value: unknown, name: string, max: number) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(name + '不能为空或超过 ' + max + ' 字符'); return value.trim(); };
export function scopeConfig(value: any): Scope { const cwd = resolve(boundText(value?.cwd, '工作区', 4096)), path = canonical(cwd); if (value.canonical && value.canonical !== path) throw new Error('工作区实际位置已变化，请重新选择'); const projectId = value.projectId === undefined || value.projectId === '' ? undefined : boundText(value.projectId, '项目', 100); return { cwd, canonical: path, ...(projectId ? { projectId } : {}) }; }
export function budgetConfig(raw: any, schedule = false): Budget {
  const values = { turns: schedule ? 1 : raw?.turns, requests: raw?.requests, tools: raw?.tools, tokens: raw?.tokens, minutes: raw?.minutes } as Budget;
  const ranges = { turns: [1, 30], requests: [1, 200], tools: [1, 400], tokens: [2048, 2000000], minutes: [1, 240] };
  for (const [key, range] of Object.entries(ranges)) { const v = values[key as keyof Budget]; if (!Number.isSafeInteger(v) || v < range[0]! || v > range[1]!) throw new Error('预算 ' + key + ' 必须为 ' + range.join('～') + ' 的整数'); }
  return values;
}
export function commonTask(value: any) { return { ...scopeConfig(value), title: boundText(value.title, '名称', 100), instructions: boundText(value.instructions, '任务说明', 16000), model: boundText(value.model, '模型', 400) }; }
export function goalConfig(value: any): GoalConfig {
  const common = commonTask(value); if (!['plan', 'default', 'acceptEdits'].includes(value.mode)) throw new Error('持续任务使用计划、默认或允许编辑权限');
  const completion = value.completion?.kind === 'review' ? { kind: 'review' as const } : value.completion?.kind === 'file' ? { kind: 'file' as const, path: localPath(common.cwd, value.completion.path), contains: boundText(value.completion.contains, '验收文字', 2000) } : undefined;
  if (!completion || typeof value.stopOnIssue !== 'boolean') throw new Error('请明确完成条件和失败时的停止策略');
  return { ...common, mode: value.mode, completion, budget: budgetConfig(value.budget), stopOnIssue: value.stopOnIssue };
}
export function localPath(cwd: string, value: unknown) { const path = boundText(value, '资料路径', 4096); if (!isInsideWorkspace(cwd, path) || isSensitivePath(cwd, path)) throw new Error('资料与验收文件必须在工作区内且不属于敏感路径'); return path; }
export function timingConfig(value: any): ScheduleTiming {
  if (value?.kind === 'once') { const time = Date.parse(value.at); if (!Number.isFinite(time)) throw new Error('一次性执行时间无效'); return { kind: 'once', at: new Date(time).toISOString() }; }
  if (value?.kind === 'interval' && Number.isSafeInteger(value.minutes) && value.minutes >= 5 && value.minutes <= 10080) return { kind: 'interval', minutes: value.minutes };
  if (value?.kind === 'daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) && typeof value.timezone === 'string' && value.timezone.length <= 100) { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); return { kind: 'daily', time: value.time, timezone: value.timezone }; }
  throw new Error('请选择有效时间；重复间隔为 5 分钟～7 天');
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function localMinute(time: number, timezone: string) { let fmt = formatters.get(timezone); if (!fmt) { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); if (formatters.size >= 64) formatters.clear(); formatters.set(timezone, fmt); } const parts = Object.fromEntries(fmt.formatToParts(time).map(part => [part.type, part.value])); return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }; }
export function slotKey(timing: ScheduleTiming, at: number) { return timing.kind === 'daily' ? localMinute(at, timing.timezone).date : new Date(at).toISOString(); }
/** Strictly future slots; DST gaps are skipped and a repeated local date runs once. */
export function nextSlot(timing: ScheduleTiming, after: number, lastSlot?: string): number | undefined {
  if (timing.kind === 'once') { const time = Date.parse(timing.at); return time > after && lastSlot !== new Date(time).toISOString() ? time : undefined; }
  if (timing.kind === 'interval') return after + timing.minutes * 60000;
  for (let time = (Math.floor(after / 60000) + 1) * 60000, end = time + 3 * 86400000; time < end; time += 60000) { const local = localMinute(time, timing.timezone); if (local.time === timing.time && local.date !== lastSlot) return time; }
  throw new Error('无法计算未来执行时间，请检查时区');
}
export function memoryConfig(value: any): MemoryConfig { const common = scopeConfig(value); if (!['manual', 'conversation'].includes(value.source?.kind) || typeof value.auto !== 'boolean') throw new Error('记忆来源或自动引用设置无效'); return { ...common, title: boundText(value.title, '记忆名称', 100), body: boundText(value.body, '记忆正文', 8000), auto: value.auto, source: { kind: value.source.kind, note: boundText(value.source.note, '来源说明', 1000), ...(value.source.kind === 'conversation' ? { threadId: boundText(value.source.threadId, '来源对话', 100), itemId: boundText(value.source.itemId, '来源消息', 100) } : {}) } }; }
