import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInsideWorkspace, isSensitivePath } from '@smalt/kernel';
import { prepareLaunch } from './process-manager.js';
import type { ProcessLaunch, ProjectOperation } from '../shared/processes.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ProjectOperations {
  private readonly file: string;
  constructor(directory: string) { mkdirSync(directory, { recursive: true }); this.file = join(directory, 'project-operations.json'); }
  private saved(): Array<{ workspace: string; id: string; title: string; launch: ProcessLaunch }> {
    if (!existsSync(this.file)) return [];
    if (statSync(this.file).size > 512 * 1024) throw new Error('项目操作记录过大，原文件已保留');
    const values = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(values) || values.length > 300 || values.some(value => !value || typeof value.workspace !== 'string' || typeof value.id !== 'string' || typeof value.title !== 'string' || !value.launch || typeof value.launch !== 'object')) throw new Error('项目操作记录损坏，原文件已保留');
    return values;
  }
  list(workspace: string): { operations: ProjectOperation[]; notice?: string } {
    const operations: ProjectOperation[] = [];
    let notice: string | undefined;
    const add = (id: string, title: string, launch: ProcessLaunch, origin: ProjectOperation['origin'], evidence?: unknown) => operations.push({ id, title, launch, cwd: resolve(workspace, launch.cwd ?? '.'), origin, script: origin === 'package' && evidence ? ['pre' + id.slice(8), id.slice(8), 'post' + id.slice(8)].filter(name => typeof (evidence as Record<string, unknown>)[name] === 'string').map(name => name + ': ' + (evidence as Record<string, string>)[name]).join('\n') : undefined, digest: digest({ id, launch, evidence }) });
    const manifest = join(workspace, 'package.json');
    if (isInsideWorkspace(workspace, manifest) && !isSensitivePath(workspace, manifest) && existsSync(manifest)) try {
      if (statSync(manifest).size > 128 * 1024) throw new Error('package.json 超过读取上限');
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data.scripts && typeof data.scripts === 'object' && !Array.isArray(data.scripts)) for (const [name, script] of Object.entries(data.scripts).slice(0, 50)) {
        if (name.length <= 100 && !/[\x00-\x1f]/.test(name) && typeof script === 'string' && script.length <= 8192) add('package:' + name, name, { program: 'npm', args: ['run', name] }, 'package', data.scripts);
      }
    } catch (error) { notice = '无法读取项目脚本：' + (error instanceof Error ? error.message : String(error)); }
    try { for (const item of this.saved().filter(value => value.workspace === workspace)) add(item.id, item.title, item.launch, 'custom'); }
    catch (error) { notice = error instanceof Error ? error.message : String(error); }
    add('builtin:git-status', 'Git 状态', { program: 'git', args: ['status', '--short', '--branch'] }, 'builtin');
    return { operations, notice };
  }
  resolve(workspace: string, id: string, expectedDigest: string): ProjectOperation {
    const operation = this.list(workspace).operations.find(value => value.id === id);
    if (!operation || operation.digest !== expectedDigest) throw new Error('项目操作已变化，请刷新并核对后再运行');
    prepareLaunch(workspace, operation.launch);
    return operation;
  }
  save(workspace: string, title: string, launch: ProcessLaunch) {
    if (typeof title !== 'string' || !title.trim() || title.length > 100) throw new Error('操作名称不能为空，最多 100 字符');
    prepareLaunch(workspace, launch);
    const saved = this.saved();
    if (saved.length >= 300 || saved.filter(item => item.workspace === workspace).length >= 30) throw new Error('项目操作达到数量上限');
    saved.push({ workspace, id: 'custom:' + randomUUID(), title: title.trim(), launch: { program: launch.program, command: launch.command, args: launch.args, cwd: launch.cwd } }); this.write(saved);
  }
  remove(workspace: string, id: string) { this.write(this.saved().filter(item => item.workspace !== workspace || item.id !== id)); }
  private write(saved: unknown[]) { const temporary = this.file + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 }); renameSync(temporary, this.file); }
}
