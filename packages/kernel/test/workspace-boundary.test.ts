/**
 * Workspace-boundary suite (K1/K2 hardening):
 * symlink/junction escapes, out-of-workspace reads, sensitive directories,
 * and the never-writable agent-config directory.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ToolOrchestrator } from '../src/tools/orchestrator.js';
import { ToolRegistry, defaultTools } from '../src/tools/registry.js';
import { HookBus } from '../src/hooks/bus.js';
import { PermissionService } from '../src/permissions/service.js';
import { parseRule } from '../src/permissions/rules.js';
import { isInsideWorkspace, isSensitivePath } from '../src/tools/workspace-guard.js';

let dir: string;
let outside: string;
let approvals: Array<{ tool: string; detail?: string }>;
let orchestrator: ToolOrchestrator;

const prevSmaltHome = process.env.SMALT_HOME;

function buildOrchestrator(mode?: string, allow: string[] = [], deny: string[] = []) {
  const permissions = new PermissionService(
    deny.map((r) => parseRule(r, 'user')),
    allow.map((r) => parseRule(r, 'user')),
    [],
  );
  if (mode) permissions.setMode(mode as never);
  return new ToolOrchestrator({
    tools: new ToolRegistry(defaultTools()),
    permissions,
    hooks: new HookBus(() => {}),
    requestApproval: async (req) => {
      approvals.push({ tool: req.tool, detail: req.detail });
      return { decision: 'deny', reason: 'auto-deny in test' };
    },
    askUser: async () => '',
    log: () => {},
  });
}

const ctx = () => ({
  cwd: dir,
  threadId: 'th_wb',
  turnId: 'turn_wb',
  itemId: 'item_wb',
  signal: new AbortController().signal,
  log: () => {},
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smalt-wb-'));
  outside = mkdtempSync(join(tmpdir(), 'smalt-out-'));
  approvals = [];
  orchestrator = buildOrchestrator('acceptEdits', ['read', 'edit:src/**']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/* --------------------------------- K1 ---------------------------------- */

describe('K1: symlink/junction escapes are resolved before the boundary check', () => {
  it('write through an in-workspace junction to outside is denied', async () => {
    const link = join(dir, 'link-out');
    symlinkSync(outside, link, 'junction');
    const out = await orchestrator.execute('c1', 'write', { path: 'link-out/pwn.txt', content: 'x' }, ctx());
    expect(out.denied).toBe(true);
    expect(existsSync(join(outside, 'pwn.txt'))).toBe(false);
  });

  it('symlink escapes are denied too (where symlinks are creatable)', async () => {
    const link = join(dir, 'sym-out');
    try {
      symlinkSync(outside, link, 'dir');
    } catch {
      // Windows without developer mode: junction path above covers it
      return;
    }
    const out = await orchestrator.execute('c2', 'write', { path: 'sym-out/pwn.txt', content: 'x' }, ctx());
    expect(out.denied).toBe(true);
  });

  it('apply_patch through a junction is denied', async () => {
    const link = join(dir, 'j');
    symlinkSync(outside, link, 'junction');
    const patch = '*** Begin Patch\n*** Add File: j/new.txt\n+x\n*** End Patch';
    const out = await orchestrator.execute('c3', 'apply_patch', { patch }, ctx());
    expect(out.denied).toBe(true);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('isInsideWorkspace matches platform case sensitivity', () => {
    if (process.platform === 'win32') {
      expect(isInsideWorkspace(dir, dir.toUpperCase())).toBe(true);
    } else {
      expect(isInsideWorkspace(dir, dir.toUpperCase())).toBe(false);
    }
  });
});

/* --------------------------------- K2 ---------------------------------- */

describe('K2: reads outside the workspace always ask; sensitive dirs deny', () => {
  it('read of an outside file is downgraded to an approval even with `allow: read`', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    const out = await orchestrator.execute('c1', 'read', { path: join(outside, 'secret.txt') }, ctx());
    // approval fired (and our auto-denier answered) → not silently allowed
    expect(approvals.length).toBeGreaterThanOrEqual(1);
    expect(approvals[0]!.detail).toContain('OUTSIDE');
    expect(out.denied).toBe(true);
  });

  it('read of an in-workspace file stays silent (allow: read)', async () => {
    writeFileSync(join(dir, 'note.txt'), 'hello');
    const out = await orchestrator.execute('c2', 'read', { path: 'note.txt' }, ctx());
    expect(approvals).toHaveLength(0);
    expect(out.isError).toBe(false);
    expect(out.output).toContain('hello');
  });

  it('grep outside the workspace asks', async () => {
    writeFileSync(join(outside, 'data.txt'), 'needle');
    const out = await orchestrator.execute('c3', 'grep', { pattern: 'needle', path: outside }, ctx());
    expect(approvals.length).toBeGreaterThanOrEqual(1);
    expect(out.denied).toBe(true);
  });

  it('sensitive directories are denied outright for reads', async () => {
    const sshDir = join(homedir(), '.ssh');
    const out = await orchestrator.execute('c4', 'glob', { pattern: '**/*', path: sshDir }, ctx());
    expect(out.denied).toBe(true);
    expect(out.output).toContain('off-limits');
  });

  it('isSensitivePath recognizes the agent config dir', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'smalt-home-'));
    process.env.SMALT_HOME = join(fakeHome, '.smalt');
    try {
      expect(isSensitivePath(fakeHome, '.smalt/settings.json')).toBe(true);
      expect(isSensitivePath(fakeHome, 'project/main.ts')).toBe(false);
    } finally {
      delete process.env.SMALT_HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

/* ------------------------------ ~/.smalt ban ---------------------------- */

describe('the agent config directory is never writable (anti self-escalation)', () => {
  it('write into SMALT_HOME is denied even under bypassPermissions', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'smalt-cfg-'));
    process.env.SMALT_HOME = join(fakeHome, '.smalt');
    try {
      const orch = buildOrchestrator('bypassPermissions');
      const out = await orch.execute(
        'c1',
        'write',
        { path: join(fakeHome, '.smalt', 'settings.json'), content: '{"permissions":{"mode":"bypassPermissions"}}' },
        ctx(),
      );
      expect(out.denied).toBe(true);
      expect(out.output).toContain('never writable');
    } finally {
      delete process.env.SMALT_HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('workspace-internal writes next to a config dir are unaffected', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const out = await orchestrator.execute('c2', 'write', { path: 'src/app.ts', content: 'ok' }, ctx());
    expect(out.denied).toBe(false);
    void prevSmaltHome;
  });
});
