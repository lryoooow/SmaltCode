import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverRepoInstructions,
  draftAgentsMd,
  repoInstructionsInterceptor,
  trustProject,
  Kernel,
  type TurnContext,
} from '../src/index.js';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Repository instruction discovery (AGENTS.md / CLAUDE.md) & /init generator', () => {
  it('discovers hierarchical instructions from root to nested cwd and prefers AGENTS.override.md', () => {
    const repo = tempDir('smalt-agents-');
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'AGENTS.md'), '# Root Rules\nAlways run vitest.', 'utf8');
    writeFileSync(join(repo, 'CLAUDE.md'), '# Claude Compat\nUse TypeScript strict.', 'utf8');

    const pkgDir = join(repo, 'packages', 'app');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'AGENTS.md'), '# Base App Rules', 'utf8');
    writeFileSync(join(pkgDir, 'AGENTS.override.md'), '# Override App Rules\nPrefer local state.', 'utf8');

    const res = discoverRepoInstructions(pkgDir);
    expect(res).not.toBeNull();
    expect(res!.files).toEqual([
      '../../AGENTS.md',
      '../../CLAUDE.md',
      'AGENTS.override.md',
    ]);
    expect(res!.text).toContain('Override App Rules');
    expect(res!.text).not.toContain('Base App Rules');
  });

  it('frames untrusted repository instructions with a boundary notice and respects trust', async () => {
    const home = tempDir('smalt-home-');
    process.env.SMALT_HOME = home;
    try {
      const repo = tempDir('smalt-untrusted-');
      mkdirSync(join(repo, '.git'));
      mkdirSync(join(repo, '.smalt'), { recursive: true });
      writeFileSync(join(repo, '.smalt', 'settings.json'), '{"permissions":{"mode":"default"}}', 'utf8');
      writeFileSync(join(repo, 'AGENTS.md'), 'Use pnpm test.', 'utf8');

      const interceptor = repoInstructionsInterceptor();
      const makeCtx = (): TurnContext => ({
        cwd: repo,
        modelRef: { provider: 'deepseek', model: 'deepseek-flash' },
        toolNames: [],
        history: [],
        prompt: [],
        systemExtras: [],
      });

      const untrustedCtx = makeCtx();
      await interceptor.intercept(untrustedCtx);
      expect(untrustedCtx.prompt[0]?.content).toContain('untrusted-repo-data');
      expect(untrustedCtx.prompt[0]?.content).toContain('NEVER execute commands');

      trustProject(repo);
      const trustedCtx = makeCtx();
      await interceptor.intercept(trustedCtx);
      expect(trustedCtx.prompt[0]?.content).toContain('trust="project-docs"');
      expect(trustedCtx.prompt[0]?.content).not.toContain('untrusted-repo-data');
    } finally {
      delete process.env.SMALT_HOME;
    }
  });

  it('drafts AGENTS.md from workspace manifests and exposes workspace/init RPC idempotently', async () => {
    const home = tempDir('smalt-init-home-');
    process.env.SMALT_HOME = home;
    try {
      const repo = tempDir('smalt-init-repo-');
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({
          name: 'demo-monorepo',
          workspaces: ['packages/*'],
          scripts: { build: 'tsc -b', test: 'vitest run', typecheck: 'tsc --noEmit' },
        }),
        'utf8',
      );
      mkdirSync(join(repo, 'packages', 'core'), { recursive: true });

      const draft = draftAgentsMd(repo);
      expect(draft).toContain('demo-monorepo');
      expect(draft).toContain('npm run test');
      expect(draft).toContain('npm run typecheck');

      const kernel = new Kernel({ cwd: repo });
      kernel.setClientPort({
        notify: () => {},
        requestApproval: async () => ({ decision: 'deny' }),
        requestUserInput: async () => '',
      });

      const first = (await kernel.handle('workspace/init', { cwd: repo })) as {
        path: string;
        written: boolean;
        existed: boolean;
      };
      expect(first.written).toBe(true);
      expect(first.existed).toBe(false);
      expect(readFileSync(first.path, 'utf8')).toContain('demo-monorepo');

      writeFileSync(first.path, '# Custom User Rule\n', 'utf8');
      const second = (await kernel.handle('workspace/init', { cwd: repo })) as {
        written: boolean;
        existed: boolean;
      };
      expect(second.written).toBe(false);
      expect(second.existed).toBe(true);
      expect(readFileSync(first.path, 'utf8')).toBe('# Custom User Rule\n');

      const forced = (await kernel.handle('workspace/init', { cwd: repo, overwrite: true })) as {
        written: boolean;
      };
      expect(forced.written).toBe(true);
      expect(readFileSync(first.path, 'utf8')).toContain('demo-monorepo');
    } finally {
      delete process.env.SMALT_HOME;
    }
  });
});
