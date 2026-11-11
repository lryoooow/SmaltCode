import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kernel, type ToolDefinition } from '@smalt/kernel';
import { shellTool } from '../../kernel/src/tools/defs/shell.js';
import { ProcessManager } from '../src/main/process-manager.js';
import { backgroundShell, processWriteTool } from '../src/main/process-tools.js';
import { createActivateSkillTool, parseSkill, SkillStore } from '../src/main/skills.js';
import { isVirtualContextPath, readVirtualContext } from '../src/main/context-files.js';
import { Autonomy } from '../src/main/autonomy.js';
import { validateMacBuild } from '../../../scripts/macos-build-policy.mjs';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'test',
    encryptString: (v: string) => Buffer.from('sealed:' + v),
    decryptString: (v: Buffer) => v.toString().slice(7),
  },
}));

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runTool(tool: ToolDefinition, input: unknown, cwd: string, threadId = 'th_1') {
  let result = { text: '', isError: false as boolean | undefined };
  for await (const ev of tool.run(input, {
    cwd,
    threadId,
    turnId: 't_1',
    callId: 'c_1',
    signal: new AbortController().signal,
  })) {
    if (ev.type === 'result') result = { text: ev.text, isError: ev.isError };
  }
  return result;
}

describe('v0.0.8 desktop upgrade features (U2b, U9a, U9b, U10, macOS ad-hoc)', () => {
  it('allows process_write to send stdin to background shell processes while refusing manual terminals', async () => {
    const root = tempDir('smalt-procwrite-');
    const cwd = join(root, 'ws');
    mkdirSync(cwd);
    const writes: string[] = [];
    let pidSeq = 42000;
    const manager = new ProcessManager({
      directory: root,
      runtime: root,
      thread: () => ({ cwd, archived: false }),
      canInput: () => true,
      notify: () => {},
      spawn: () => {
        let onExitCb: ((e: { exitCode: number }) => void) | undefined;
        return {
          pid: ++pidSeq,
          onData: () => ({ dispose() {} }),
          onExit: (cb: (e: { exitCode: number }) => void) => {
            onExitCb = cb;
            return { dispose() {} };
          },
          write: (data: string) => writes.push(data),
          resize: vi.fn(),
          kill: () => onExitCb?.({ exitCode: 1 }),
        } as unknown as IPty;
      },
    });

    try {
      const terminal = await manager.start('th_1', {}, 'user', true);
      expect(() => manager.writeBackgroundInput('th_1', terminal.id, 'secret\n')).toThrow('手动交互终端');

      const bgTool = backgroundShell(shellTool, manager);
      const started = await runTool(bgTool, { command: 'npm run dev', background: true }, cwd, 'th_1');
      const bgId = JSON.parse(started.text).process.id as string;

      const writeTool = processWriteTool(manager);
      const res = await runTool(writeTool, { id: bgId, input: 'y', appendNewline: true, waitMs: 60 }, cwd, 'th_1');
      expect(res.isError).toBeFalsy();
      expect(writes).toEqual([process.platform === 'win32' ? 'y\r' : 'y\n']);
    } finally {
      await manager.shutdown();
    }
  });

  it('publishes <available-skills> metadata summary and discloses full SKILL.md + local references via activate_skill', async () => {
    const root = tempDir('smalt-skill-prog-');
    const skillDir = join(root, 'local-skill');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    const skillMdPath = join(skillDir, 'SKILL.md');
    writeFileSync(
      skillMdPath,
      '---\nname: 架构审查\ndescription: 执行模块化边界审查流程\n---\n# 架构审查\n请按模块边界逐层核对。',
      'utf8',
    );
    writeFileSync(join(skillDir, 'references', 'checklist.md'), '- 检查循环依赖\n', 'utf8');

    const store = new SkillStore(join(root, 'store'));
    const imported = await store.import(parseSkill(readFileSync(skillMdPath, 'utf8'), 'file', skillMdPath));
    await store.configure(imported.id, true);

    await store.list();
    const summary = store.latestCatalogSummary();
    expect(summary).toContain('<available-skills>');
    expect(summary).toContain('架构审查');

    const tool = createActivateSkillTool(store);
    const full = await runTool(tool, { id: imported.id }, root);
    expect(full.isError).toBeFalsy();
    expect(full.text).toContain('请按模块边界逐层核对');

    const refOut = await runTool(tool, { id: imported.id, referencePath: 'references/checklist.md' }, root);
    expect(refOut.isError).toBeFalsy();
    expect(refOut.text).toContain('检查循环依赖');

    const traversal = await runTool(tool, { id: imported.id, referencePath: '../secret.txt' }, root);
    expect(traversal.isError).toBe(true);
  });

  it('resolves @git:status, @git:diff, and @terminal virtual contexts safely', async () => {
    const repo = tempDir('smalt-virtctx-');
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'demo.ts'), 'export const x = 1;\n', 'utf8');

    expect(isVirtualContextPath('@git:status')).toBe(true);
    expect(isVirtualContextPath('@git:diff')).toBe(true);
    expect(isVirtualContextPath('@terminal')).toBe(true);
    expect(isVirtualContextPath('src/index.ts')).toBe(false);

    const status = await readVirtualContext(repo, '@git:status');
    expect(status.text).toContain('demo.ts');

    const term = await readVirtualContext(repo, '@terminal', () => 'Server listening on :3000');
    expect(term.text).toContain('Server listening on :3000');
  });

  it('extracts reviewable project memory suggestions from explicit user conventions without storing secrets', async () => {
    const home = tempDir('smalt-mem-home-');
    const ws = tempDir('smalt-mem-ws-');
    process.env.SMALT_HOME = home;
    try {
      const kernel = new Kernel({ cwd: ws });
      kernel.setClientPort({
        notify: () => {},
        requestApproval: async () => ({ decision: 'deny' }),
        requestUserInput: async () => '',
      });
      const rt = kernel.threads.start({ cwd: ws, title: 'Conventions' });
      rt.items.push({
        id: 'u_rule',
        kind: 'userMessage',
        turnId: 't1',
        text: '请记住：本项目统一使用 vitest 运行测试，禁止使用 jest。\n另外不要保存 sk-1234567890abcdefSECRET',
      });

      const autonomy = new Autonomy({
        directory: join(home, 'autonomy'),
        kernel,
        scope: async () => {},
        modelFingerprint: () => 'fp',
        read: async () => ({ text: '' }),
        context: async () => ({ text: '', references: [] }),
        consent: async () => true,
        cleanup: async () => {},
        notify: () => {},
        online: () => true,
        startTimer: false,
      });

      const candidates = autonomy.suggestMemories(rt.meta.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.body).toContain('vitest');
      expect(candidates[0]?.body).not.toContain('sk-1234567890');
      await autonomy.shutdown();
    } finally {
      delete process.env.SMALT_HOME;
    }
  });

  it('validates opt-in macOS ad-hoc build policy and electron-builder.mac-adhoc.yml schema', async () => {
    expect(
      validateMacBuild({ platform: 'darwin', arch: 'arm64', targetArch: 'arm64', env: {}, adhoc: true }),
    ).toBe('arm64');
    expect(() =>
      validateMacBuild({
        platform: 'darwin',
        arch: 'arm64',
        targetArch: 'arm64',
        env: { CSC_NAME: 'Developer ID Application: Test' },
        adhoc: true,
      }),
    ).toThrow('不应混入');

    const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
    const base: any = load(readFileSync(join(process.cwd(), 'packages/desktop/electron-builder.yml'), 'utf8'));
    const adhocCfg: any = load(
      readFileSync(join(process.cwd(), 'packages/desktop/electron-builder.mac-adhoc.yml'), 'utf8'),
    );
    await expect(validateConfiguration({ ...base, ...adhocCfg }, { isEnabled: false } as any)).resolves.toBeUndefined();
  });
});
