import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { smaltHome } from '../config/settings.js';
import type { ProjectMeta } from '../protocol/types.js';
import { newId, nowIso } from '../util.js';

/** User-created conversation groups, persisted separately from chat logs. */
export class ProjectStore {
  private readonly file: string;
  constructor(file = join(smaltHome(), 'projects.json')) { this.file = file; }
  list(): ProjectMeta[] {
    if (!existsSync(this.file)) return [];
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Project storage is invalid');
    return data;
  }
  require(id: string): ProjectMeta {
    const project = this.list().find(p => p.id === id);
    if (!project) throw new Error('Project not found');
    return project;
  }
  create(input: { name: string; instructions?: string; cwd?: string }): ProjectMeta {
    const projects = this.list();
    const project: ProjectMeta = { id: newId('pr'), name: this.name(input.name), instructions: this.instructions(input.instructions ?? ''), cwd: input.cwd || undefined, createdAt: nowIso(), updatedAt: nowIso() };
    this.write([...projects, project]);
    return project;
  }
  update(id: string, input: { name?: string; instructions?: string; cwd?: string | null }): ProjectMeta {
    const projects = this.list(); const project = projects.find(p => p.id === id);
    if (!project) throw new Error('Project not found');
    if (input.name !== undefined) project.name = this.name(input.name);
    if (input.instructions !== undefined) project.instructions = this.instructions(input.instructions);
    if (input.cwd !== undefined) project.cwd = input.cwd || undefined;
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
  private write(projects: ProjectMeta[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(projects, null, 2) + '\n', 'utf8');
    renameSync(temp, this.file);
  }
}
