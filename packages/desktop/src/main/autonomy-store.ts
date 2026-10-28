import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutonomyData } from '../shared/autonomy.js';
const empty = (): AutonomyData => ({ version: 1, goals: [], schedules: [], memories: [], templates: [], uses: [], runs: [] });
const text = (v: unknown, max: number, optional = false) => optional && v === undefined || typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const date = (v: unknown, optional = false) => optional && v === undefined || typeof v === 'string' && Number.isFinite(Date.parse(v));
const ident = (v: unknown) => typeof v === 'string' && /^[a-z]+_[a-f0-9-]{36}$/.test(v);
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const evidence = (v: any) => v && text(v.path, 4096) && digest(v.digest) && text(v.label, 4096);
const refs = (v: any) => Array.isArray(v) && v.length <= 6 && v.every(evidence);
const budget = (v: any, goal = false) => v && (!goal || integer(v.turns, 1, 30)) && integer(v.requests, 1, 200) && integer(v.tools, 1, 400) && integer(v.tokens, 2048, 2000000) && integer(v.minutes, 1, 240);
const mode = (v: unknown) => ['plan', 'default', 'acceptEdits'].includes(v as string);
function configuration(v: any) {
  // Do not touch the filesystem while reading: a removed/offline workspace must remain editable.
  return text(v.cwd, 4096) && text(v.canonical, 4096) && text(v.projectId, 100, true) && text(v.title, 100) && integer(v.revision, 1) && date(v.createdAt) && date(v.updatedAt) && text(v.reason, 2000, true);
}
function validData(value: any) {
  if (value?.version !== 1) return false;
  const limits = { goals: 60, schedules: 60, memories: 100, templates: 60, uses: 1000, runs: 240 };
  for (const [key, limit] of Object.entries(limits)) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > limit || entries.some((entry: any) => !entry || !ident(entry.id)) || new Set(entries.map((entry: any) => entry.id)).size !== entries.length) return false;
  }
  for (const v of [...value.goals, ...value.schedules, ...value.memories, ...value.templates]) if (!configuration(v)) return false;
  for (const g of value.goals) if (!text(g.instructions, 16000) || !text(g.model, 400) || !mode(g.mode) || !budget(g.budget, true) || typeof g.stopOnIssue !== 'boolean' || !['draft','running','paused','review','completed','stopped','budget','blocked'].includes(g.status) || !g.spent || !['turns','requests','tools','tokens','milliseconds'].every(k => integer(g.spent[k])) || !integer(g.repeats) || !text(g.threadId, 100, true) || !(g.lastFingerprint === undefined || digest(g.lastFingerprint)) || !(g.completion?.kind === 'review' || g.completion?.kind === 'file' && text(g.completion.path,4096) && text(g.completion.contains,2000))) return false;
  for (const s of value.schedules) {
    if (!text(s.instructions,16000) || !text(s.model,400) || !budget(s.budget) || typeof s.enabled !== 'boolean' || !integer(s.executions) || !integer(s.maxRuns,1,1000) || !date(s.endsAt,true) || !date(s.nextAt,true) || !text(s.lastSlot,200,true) || !refs(s.references) || !Array.isArray(s.memoryIds) || s.memoryIds.length>4 || !s.memoryIds.every(ident)) return false;
    const t=s.timing;
    if (!(t?.kind==='once' && date(t.at) || t?.kind==='interval' && integer(t.minutes,5,10080) || t?.kind==='daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) && text(t.timezone,100))) return false;
    if (t.kind==='daily') { try { new Intl.DateTimeFormat('en',{timeZone:t.timezone}); } catch { return false; } }
  }
  for (const m of value.memories) if (!text(m.body,8000) || typeof m.auto!=='boolean' || !digest(m.digest) || !text(m.source?.note,1000) || !(m.source.kind==='manual' || m.source.kind==='conversation' && text(m.source.threadId,100) && text(m.source.itemId,100))) return false;
  for (const t of value.templates) if (!text(t.instructions,16000) || !text(t.model,400) || !mode(t.mode) || typeof t.output!=='string' || t.output.length>8000 || !refs(t.references) || !Array.isArray(t.variables) || t.variables.length>8 || !t.variables.every((v: unknown)=>typeof v==='string' && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(v))) return false;
  for (const u of value.uses) if (!ident(u.memoryId) || !digest(u.digest) || !text(u.title,100) || !text(u.threadId,100) || !date(u.at) || !['message','queued','managed'].includes(u.kind) || !(u.runId===undefined || ident(u.runId))) return false;
  for (const r of value.runs) if (!ident(r.ownerId) || !['goal','schedule'].includes(r.kind) || !text(r.slot,200) || !['running','completed','interrupted','failed','skipped','review','budget'].includes(r.status) || !date(r.startedAt) || !date(r.endedAt,true) || !text(r.threadId,100,true) || !text(r.turnId,100,true) || !text(r.reason,2000,true) || !(r.summary===undefined || typeof r.summary==='string' && r.summary.length<=3000) || !refs(r.evidence) || !(r.metrics===undefined || r.metrics && ['requests','chargedTokens','toolCalls'].every(k=>integer(r.metrics[k]))) || !(r.usage===undefined || r.usage && integer(r.usage.inputTokens) && integer(r.usage.outputTokens))) return false;
  return true;
}
/** Preserve malformed original bytes and isolate failure from ordinary conversations. */
export class AutonomyStore {
  data = empty(); notice?: string; private file: string;
  constructor(private directory: string) {
    this.file = join(directory, 'autonomy.json'); if (!existsSync(this.file)) return;
    try {
      const bytes = readFileSync(this.file); if (bytes.length > 8 * 1024 * 1024) throw new Error('Large data'); const value = JSON.parse(bytes.toString());
      if (!validData(value)) throw new Error('Invalid configuration');
      this.data = value;
    } catch { this.notice = '持续任务数据损坏或版本不兼容，已停止自动执行。原 autonomy.json 保留，请恢复备份后重启；普通对话仍可使用。'; }
  }
  save(value: AutonomyData) {
    if (this.notice) throw new Error(this.notice); const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error('持续任务数据超过 8 MB，请清理历史或减少资料');
    for (const [key, max] of Object.entries({ goals:60,schedules:60,memories:100,templates:60,uses:1000,runs:240 })) if (value[key as keyof AutonomyData] instanceof Array && (value[key as keyof AutonomyData] as any[]).length > max) throw new Error(key + ' 数量已达到上限');
    try {
      mkdirSync(this.directory, { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, this.file); this.data = structuredClone(value);
    } catch (error) {
      this.notice = '持续任务数据保存失败，已停止自动执行。请检查磁盘空间和目录权限后重启；普通对话仍可使用。';
      throw new Error(this.notice, { cause: error });
    }
  }
}
