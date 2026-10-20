import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, copyFileSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { smaltHome } from '../config/settings.js';
import type { ProjectMeta } from '../protocol/types.js';
import { newId, nowIso } from '../util.js';
import { fileStamp } from './meta-index.js';

/** User-created conversation groups, persisted separately from chat logs. */
export class ProjectStore {
  private readonly file: string;
  notice?: string;
  private damaged = false;
  private unreadable = false;
  private observed?: string;
  constructor(file = join(smaltHome(), 'projects.json')) { this.file = file; }
  list(): ProjectMeta[] {
    this.notice = undefined; this.damaged = false; this.unreadable = false;
    this.observed = undefined;
    if (!existsSync(this.file)) return [];
    try {
      this.observed = fileStamp(statSync(this.file));
      const parsed = this.read(this.file);
      if (parsed.invalid && !parsed.projects.length) throw new Error('No valid project records');
      if (parsed.invalid) { this.damaged = true; this.notice = `项目资料中有 ${parsed.invalid} 条无效或重复记录，已保留其余项目；原文件保持完整。`; }
      return parsed.projects;
    } catch {
      this.damaged = true;
      try { const fd = openSync(this.file, 'r'); closeSync(fd); } catch { this.unreadable = true; }
      try {
        const backup = this.read(this.file + '.bak');
        if (backup.invalid) throw new Error('Invalid backup');
        this.notice = '项目资料无法读取，已使用上次备份显示项目；原文件未覆盖。新建或修改项目时会先保存损坏副本。';
        return backup.projects;
      } catch {
        this.notice = '项目资料无法读取，暂时显示空项目列表；对话与工作文件保持完整。原项目文件未覆盖，新建项目前会先保存损坏副本。';
        return [];
      }
    }
  }
  private read(file: string): { projects: ProjectMeta[]; invalid: number } {
    if (statSync(file).size > 32 * 1024 * 1024) throw new Error('Project storage is too large');
    const data: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(data)) throw new Error('Project storage is invalid');
    const projects: ProjectMeta[] = [], ids = new Set<string>(); let invalid = 0;
    for (const p of data) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || typeof p.instructions !== 'string' || p.instructions.length > 20000 || (p.cwd !== undefined && typeof p.cwd !== 'string') || typeof p.createdAt !== 'string' || !Number.isFinite(Date.parse(p.createdAt)) || typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt))) { invalid++; continue; }
      ids.add(p.id); projects.push({ id: p.id, name: p.name, instructions: p.instructions, ...(p.cwd ? { cwd: p.cwd } : {}), createdAt: p.createdAt, updatedAt: p.updatedAt });
    }
    return { projects, invalid };
  }
  require(id: string): ProjectMeta {
    const project = this.list().find(p => p.id === id);
    if (!project) throw new Error(this.notice ? '项目说明暂不可用，请恢复项目资料或将对话移出项目后继续。对话与工作文件已保留。' : 'Project not found');
    return project;
  }
  create(input: { name: string; instructions?: string; cwd?: string }): ProjectMeta {
    const projects = this.list();
    const project: ProjectMeta = { id: newId('pr'), name: this.name(input.name), instructions: this.instructions(input.instructions ?? ''), cwd: this.cwd(input.cwd), createdAt: nowIso(), updatedAt: nowIso() };
    this.write([...projects, project]);
    return project;
  }
  update(id: string, input: { name?: string; instructions?: string; cwd?: string | null }): ProjectMeta {
    const projects = this.list(); const project = projects.find(p => p.id === id);
    if (!project) throw new Error('Project not found');
    if (input.name !== undefined) project.name = this.name(input.name);
    if (input.instructions !== undefined) project.instructions = this.instructions(input.instructions);
    if (input.cwd !== undefined) project.cwd = this.cwd(input.cwd);
    project.updatedAt = nowIso(); this.write(projects); return project;
  }
  delete(id: string): void { this.require(id); this.write(this.list().filter(p => p.id !== id)); }
  private name(value: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Project name cannot be empty');
    return value.trim().slice(0, 80);
  }
  private instructions(value: string): string {
    if (typeof value !== 'string' || value.length > 20000) throw new Error('Project instructions must be at most 20000 characters');
    return value;
  }
  private cwd(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('Invalid project folder');
    return value;
  }
  private write(projects: ProjectMeta[]): void {
    if (this.unreadable) throw new Error('无法读取原项目文件，已停止保存以保护已有资料。请检查文件访问权限。');
    const current = existsSync(this.file) ? fileStamp(statSync(this.file)) : undefined;
    if (current !== this.observed) throw new Error('项目资料已被其他进程修改，请刷新后重试。');
    mkdirSync(dirname(this.file), { recursive: true });
    const text = JSON.stringify(projects, null, 2) + '\n';
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('项目资料超过 32 MB，请先清理不再需要的项目。');
    // Preserve the original bytes before repairing partial/corrupt storage.
    if (existsSync(this.file) && this.damaged) copyFileSync(this.file, this.file + '.corrupt-' + randomUUID() + '.json');
    const backup = this.file + '.bak', backupTemp = backup + '.' + randomUUID() + '.tmp';
    if (!this.damaged && existsSync(this.file)) copyFileSync(this.file, backupTemp);
    else if (!existsSync(backup)) writeFileSync(backupTemp, text, { encoding: 'utf8', mode: 0o600 });
    if (existsSync(backupTemp)) renameSync(backupTemp, backup);
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    this.notice = undefined; this.damaged = false; this.observed = fileStamp(statSync(this.file));
  }
}
