import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { searchContextFiles } from '../src/main/context-files.js';
import { FileContexts } from '../src/main/file-context.js';
import { fileContextTools } from '../src/main/file-context-tools.js';
import { SkillStore, createActivateSkillTool } from '../src/main/skills.js';

const tempDirs: string[] = [];
function makeTempDir(prefix = 'smalt-desktop-audit-v009-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('v0.0.9 Desktop Audit Regressions', () => {
  it('supports wildcard/glob queries in searchContextFiles and traverses >250 subdirectories without dropping folders', async () => {
    const ws = makeTempDir();
    for (let i = 0; i < 240; i++) {
      const sub = join(ws, `pkg_${String(i).padStart(3, '0')}`);
      mkdirSync(sub, { recursive: true });
      if (i === 235) {
        writeFileSync(join(sub, 'ARCHITECTURE.md'), '# Deep architecture doc\n');
      }
    }
    writeFileSync(join(ws, 'README.md'), '# Root readme\n');
    writeFileSync(join(ws, 'index.ts'), 'export {};\n');

    const starAll = await searchContextFiles(ws, '*');
    expect(starAll.files.length).toBeGreaterThanOrEqual(3);

    const mdGlob = await searchContextFiles(ws, '*.md');
    expect(mdGlob.files).toContain('README.md');
    expect(mdGlob.files).toContain('pkg_235/ARCHITECTURE.md');
  });

  it('supports offset/limit in resource_read, exposes workspace paths without exposing source paths, and forks FileContexts cleanly', async () => {
    const root = makeTempDir();
    const home = join(root, 'Data');
    const out1 = join(root, 'Files', 'out1');
    const out2 = join(root, 'Files', 'out2');
    const work = join(root, 'WorkRepo');
    const src = join(root, 'ReadOnlyDocs');
    for (const p of [home, out1, out2, work, src]) mkdirSync(p, { recursive: true });

    const tenLines = Array.from({ length: 10 }, (_, idx) => `line-${idx + 1}`).join('\n');
    writeFileSync(join(src, 'guide.md'), tenLines);

    const allowed = new Set([out1, out2, work]);
    const contexts = new FileContexts(home, (p) => allowed.has(p));
    contexts.ensureDraft(out1);
    const srcRoot = contexts.add(out1, src, 'source').sources[0]!;
    contexts.add(out1, work, 'workspace');
    contexts.bind(out1, 'th_src', work);

    // describe() and resource_list expose workspace path, NOT read-only source full path
    const desc = contexts.describe('th_src');
    expect(desc).toContain(JSON.stringify(work));
    expect(desc).not.toContain(JSON.stringify(src));

    const tools = fileContextTools(contexts, () => {}, async () => ({ format: 'text', text: '', warnings: [] }));
    const runTool = async (name: string, input: unknown, threadId = 'th_src') => {
      const out = [];
      for await (const ev of tools.find((t) => t.name === name)!.run(input, {
        threadId,
        cwd: work,
        turnId: 't1',
        itemId: 'i1',
        signal: new AbortController().signal,
        emitItem: async () => {},
        log: () => {},
      })) {
        out.push(ev);
      }
      return out.at(-1) as { text: string; isError?: boolean };
    };

    const listed = JSON.parse((await runTool('resource_list', {})).text);
    const wsEntry = listed.roots.find((r: any) => r.access === 'read/write');
    const roEntry = listed.roots.find((r: any) => r.access === 'read-only');
    expect(wsEntry.path).toBe(work);
    expect(roEntry.path).toBeUndefined();

    const paged = JSON.parse((await runTool('resource_read', { root: srcRoot.id, path: 'guide.md', offset: 3, limit: 4 })).text);
    expect(paged.content).toBe('line-3\nline-4\nline-5\nline-6');
    expect(paged.startLine).toBe(3);
    expect(paged.endLine).toBe(6);
    expect(paged.totalLines).toBe(10);
    expect(paged.truncated).toBe(true);

    // Forking clones associations and binds separate deliverable output directory
    const forkedView = contexts.fork('th_src', 'th_forked', work, out2);
    expect(forkedView.cwd).toBe(work);
    expect(forkedView.output).toBe(out2);
    expect(forkedView.sources).toHaveLength(1);
    expect(forkedView.workspaces).toHaveLength(1);
  });

  it('enforces workspace approval and local-target isolation on activate_skill referencePath', async () => {
    const root = makeTempDir();
    const skillDir = join(root, 'my-skill');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    const skillMd = '---\nname: local-skill\ndescription: Local skill test\n---\nUse references/api.md when needed.';
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
    writeFileSync(join(skillDir, 'references', 'api.md'), 'SECRET_OR_API_SPEC');

    const store = new SkillStore(join(root, 'skills-db'));
    const imported = await store.import({
      name: 'local-skill',
      description: 'Local skill test',
      source: 'file',
      origin: join(skillDir, 'SKILL.md'),
      text: skillMd,
      digest: '',
      warnings: [],
    });
    await store.configure(imported.id, true);

    const approvedDirs = new Set<string>();
    const remoteThreads = new Set<string>(['th_ssh']);
    const tool = createActivateSkillTool(store, {
      assertLocal: (id) => {
        if (remoteThreads.has(id)) throw new Error('远程 SSH 对话不允许读取本机技能参考文件');
      },
      canReadDir: (dir) => approvedDirs.has(dir),
    });

    const invoke = async (threadId: string, referencePath?: string) => {
      const evs = [];
      for await (const ev of tool.run(
        { id: 'local-skill', ...(referencePath ? { referencePath } : {}) },
        { threadId, cwd: root, turnId: 't1', itemId: 'i1', signal: new AbortController().signal, log: () => {} },
      )) {
        evs.push(ev);
      }
      return evs.at(-1) as { text: string; isError?: boolean };
    };

    // Unapproved skillDir -> denied
    const unapproved = await invoke('th_local', 'api.md');
    expect(unapproved.isError).toBe(true);
    expect(unapproved.text).not.toContain('SECRET_OR_API_SPEC');

    // Approved skillDir, but SSH thread -> denied
    approvedDirs.add(skillDir);
    const remoteAttempt = await invoke('th_ssh', 'api.md');
    expect(remoteAttempt.isError).toBe(true);
    expect(remoteAttempt.text).toContain('远程 SSH');

    // Approved skillDir + local thread -> allowed
    const localApproved = await invoke('th_local', 'api.md');
    expect(localApproved.isError).toBeUndefined();
    expect(localApproved.text).toContain('SECRET_OR_API_SPEC');
  });

  it('validates electron-builder.mac-adhoc.yml with custom sign-mac-adhoc.cjs hook against app-builder-lib schema', async () => {
    const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
    const repoRoot = process.cwd();
    const base: any = load(readFileSync(join(repoRoot, 'packages/desktop/electron-builder.yml'), 'utf8'));
    const adhoc: any = load(readFileSync(join(repoRoot, 'packages/desktop/electron-builder.mac-adhoc.yml'), 'utf8'));
    expect(adhoc.mac.sign).toBe('sign-mac-adhoc.cjs');
    expect(adhoc.mac.identity).toBeUndefined();
    await expect(validateConfiguration({ ...base, ...adhoc }, { isEnabled: false } as any)).resolves.toBeUndefined();
  });
});
