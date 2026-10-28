import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidWorkspace } from './workspace.js';

/** User consent is recorded by main, never inferred from renderer preferences or JSONL. */
export class WorkspaceAccess {
  private readonly roots = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try { const saved = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(saved) && saved.length <= 500) for (const root of saved) if (typeof root === 'string') this.roots.add(root); }
      catch { /* corrupted consent never grants access */ }
    }
  }
  private canonical(dir: string) {
    const check = isValidWorkspace(dir); if (!check.ok) throw new Error(check.reason);
    const path = realpathSync(dir); return process.platform === 'win32' ? path.toLowerCase() : path;
  }
  has(dir: string): boolean { try { return this.roots.has(this.canonical(dir)); } catch { return false; } }
  grant(dir: string): void {
    const root = this.canonical(dir), updated = new Set(this.roots); updated.add(root);
    if (updated.size > 500) updated.delete(updated.values().next().value!);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify([...updated]), { mode: 0o600 }); renameSync(temporary, this.file);
    this.roots.clear(); for (const entry of updated) this.roots.add(entry);
  }
  async ensure(dir: string, confirm: (dir: string) => Promise<boolean>): Promise<void> {
    const root = this.canonical(dir); if (this.roots.has(root)) return;
    let consent = this.pending.get(root);
    if (!consent) {
      consent = (async () => { if (!await confirm(dir)) throw new Error('未允许访问此工作区'); if (this.canonical(dir) !== root) throw new Error('工作区路径已变化，请重新选择'); this.grant(dir); })();
      this.pending.set(root, consent);
      void consent.finally(() => this.pending.delete(root)).catch(() => {});
    }
    await consent;
  }
}
