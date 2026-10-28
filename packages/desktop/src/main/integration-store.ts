import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { integrationDigest, mcpConfig, pluginManifest } from './integration-policy.js';
import type { McpServer, Plugin } from '../shared/integrations.js';

export class IntegrationStore {
  servers: McpServer[] = [];
  plugins: Plugin[] = [];
  notice?: string;
  private file: string;
  constructor(directory: string) {
    this.file = join(directory, 'integrations.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file); if (raw.length > 2 * 1024 * 1024) throw new Error('Too large');
      const saved = JSON.parse(raw.toString('utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.servers) || saved.servers.length > 40 || !Array.isArray(saved.plugins) || saved.plugins.length > 30) throw new Error('Invalid registry');
      const ids = new Set<string>();
      for (const entry of saved.servers) {
        if (!entry || !/^mcp_[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || typeof entry.enabled !== 'boolean' || typeof entry.origin !== 'string' || entry.origin.length > 4096 || !Array.isArray(entry.approvedTools) || entry.approvedTools.length > 64 || entry.approvedTools.some((value: unknown) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid server');
        const config = mcpConfig(entry, entry.cwd); if (entry.digest !== integrationDigest(config)) throw new Error('Server changed without review');
        ids.add(entry.id); this.servers.push({ ...config, id: entry.id, origin: entry.origin, digest: entry.digest, enabled: entry.enabled, approvedTools: entry.approvedTools, createdAt: entry.createdAt, pluginId: entry.pluginId });
      }
      for (const entry of saved.plugins) {
        const manifest = pluginManifest(JSON.stringify(entry.manifest));
        if (!/^plugin_[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || entry.digest !== integrationDigest(manifest) || !Array.isArray(entry.services) || entry.services.length > 8 || !Array.isArray(entry.skillIds) || entry.skillIds.length > 8 || entry.skillIds.some((id: unknown) => typeof id !== 'string' || !/^skill-[a-f0-9]{32}$/.test(id)) || typeof entry.cwd !== 'string' || typeof entry.origin !== 'string' || typeof entry.enabled !== 'boolean') throw new Error('Invalid plugin');
        ids.add(entry.id); this.plugins.push({ ...entry, manifest });
      }
      if (this.servers.some(server => server.pluginId && !this.plugins.some(plugin => plugin.id === server.pluginId && plugin.services.includes(server.id))) || this.plugins.some(plugin => plugin.services.some(id => !this.servers.some(server => server.id === id && server.pluginId === plugin.id)))) throw new Error('Invalid ownership');
    } catch { this.servers = []; this.plugins = []; this.notice = '连接器或插件记录损坏，已阻止连接和修改。原文件保留，请恢复 integrations.json 备份后重启；其他任务仍可使用。'; }
  }
  save(servers: McpServer[], plugins = this.plugins) {
    if (this.notice) throw new Error(this.notice);
    if (servers.length > 40 || plugins.length > 30) throw new Error('连接器最多 40 项，插件最多 30 项');
    mkdirSync(join(this.file, '..'), { recursive: true });
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: 1, servers, plugins }), { mode: 0o600 }); renameSync(temporary, this.file);
    this.servers = structuredClone(servers); this.plugins = structuredClone(plugins);
  }
}
