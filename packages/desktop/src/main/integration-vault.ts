import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Secrets never enter the integration registry, renderer state, diagnostics or model context. */
export class IntegrationVault {
  private entries = new Map<string, Record<string, any>>();
  private retired = new Set<string>();
  readonly storage: 'encrypted' | 'session';
  notice?: string;
  constructor(private file: string, private maxEntries = 100) {
    this.storage = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text') ? 'encrypted' : 'session';
    if (this.storage === 'encrypted' && existsSync(file)) {
      try { const raw = readFileSync(file); if (raw.length > 4 * 1024 * 1024) throw new Error('Vault too large'); const saved = JSON.parse(raw.toString('utf8')); if (!saved || typeof saved !== 'object' || Object.keys(saved).length > maxEntries) throw new Error('Invalid vault'); for (const [id, encrypted] of Object.entries(saved)) { if (typeof encrypted !== 'string' || encrypted.length >= 1024 * 1024) throw new Error('Invalid vault entry'); this.entries.set(id, JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')))); } }
      catch { this.entries.clear(); this.notice = '连接器凭据存储损坏或无法解密；原文件保留，请恢复备份后再配置'; }
    }
  }
  get(id: string, binding: string): Record<string, any> { const value = this.entries.get(id); return value?.binding === binding ? structuredClone(value) : { binding }; }
  save(id: string, binding: string, value: Record<string, any>) { const next = new Map(this.entries); next.set(id, { ...structuredClone(value), binding }); this.persist(next); this.remember(this.entries.get(id)); this.entries = next; }
  remove(id: string) { const next = new Map(this.entries); next.delete(id); this.persist(next); this.remember(this.entries.get(id)); this.entries = next; }
  private remember(value: unknown, key = '') { if (typeof value === 'string' && value.length >= 4 && /token|secret|bearer|password|verifier|env/i.test(key)) this.retired.add(value); else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) this.remember(child, key + '.' + name); while (this.retired.size > 512) this.retired.delete(this.retired.values().next().value!); }
  private persist(entries: Map<string, Record<string, any>>) {
    if (this.notice) throw new Error(this.notice);
    if (entries.size > this.maxEntries) throw new Error('授权记录已达到上限');
    if (this.storage !== 'encrypted') return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(Object.fromEntries([...entries].map(([id, value]) => [id, safeStorage.encryptString(JSON.stringify(value)).toString('base64')]))), { mode: 0o600 }); renameSync(temporary, this.file);
  }
  redact(value: string) {
    const secrets = new Set<string>(this.retired);
    const scan = (v: unknown, key = '') => { if (typeof v === 'string' && v.length >= 4 && /token|secret|bearer|password|verifier|env/i.test(key)) secrets.add(v); else if (v && typeof v === 'object') for (const [name, child] of Object.entries(v)) scan(child, key + '.' + name); };
    for (const entry of this.entries.values()) scan(entry);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[已隐藏凭据]');
    return value.replace(/\bBearer\s+[\w.+\-/=]+/gi, 'Bearer [已隐藏]').replace(/([?&](?:access_token|refresh_token|code|client_secret)=)[^&\s]+/gi, '$1[已隐藏]');
  }
}
