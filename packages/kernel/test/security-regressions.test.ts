/**
 * Security regression suite — every case here reproduces a reported attack
 * against the packaged CLI. They must FAIL CLOSED (deny/ask, nothing written).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandAllowedBy,
  hasRedirection,
  parseRule,
  splitCommand,
} from '../src/permissions/rules.js';
import { PermissionService } from '../src/permissions/service.js';
import { ToolOrchestrator } from '../src/tools/orchestrator.js';
import { ToolRegistry, defaultTools } from '../src/tools/registry.js';
import { HookBus } from '../src/hooks/bus.js';
import { JsonlThreadStore } from '../src/storage/jsonl.js';

const CWD = '/home/user/project';

function svc(allow?: string[], deny?: string[], mode?: string) {
  const s = new PermissionService(
    (deny ?? []).map((r) => parseRule(r, 'user')),
    (allow ?? []).map((r) => parseRule(r, 'user')),
    [],
  );
  if (mode) s.setMode(mode as never);
  return s;
}

/* ------------------------- command tokenizer --------------------------- */

describe('ATTACK: `echo hi & echo PWNED> pwned.txt` (single & chaining)', () => {
  it('single & splits segments like && does', () => {
    expect(splitCommand('echo hi & echo PWNED> pwned.txt')).toHaveLength(2);
  });

  it('an echo allow rule does NOT cover the chained write (asks instead)', () => {
    const s = svc(['shell:echo']);
    const d = s.check({
      tool: 'shell',
      input: {},
      subject: 'echo hi & echo PWNED> pwned.txt',
      cwd: CWD,
    });
    expect(d.action).not.toBe('allow');
  });

  it('quotes protect legitimate & in arguments', () => {
    const s = svc(['shell:grep']);
    const d = s.check({
      tool: 'shell',
      input: {},
      subject: 'grep "tom & jerry" notes.txt',
      cwd: CWD,
    });
    expect(d.action).toBe('allow');
  });
});

describe('ATTACK: `echo owned > hello.txt` (redirection file write)', () => {
  it('hasRedirection detects the shapes', () => {
    expect(hasRedirection('echo owned > hello.txt')).toBe(true);
    expect(hasRedirection('echo x>>log')).toBe(true);
    expect(hasRedirection('cmd 2>err')).toBe(true);
    expect(hasRedirection('cmd <input')).toBe(true);
    expect(hasRedirection('echo PWNED>pwned.txt')).toBe(true);
    expect(hasRedirection('git status --short')).toBe(false);
    expect(hasRedirection('npm run build')).toBe(false);
  });

  it('allow rules never cover redirected commands', () => {
    expect(commandAllowedBy('echo', 'echo owned > hello.txt')).toBe(false);
    expect(commandAllowedBy('npm test', 'npm test > log.txt')).toBe(false);
    const s = svc(['shell:echo']);
    expect(
      s.check({ tool: 'shell', input: {}, subject: 'echo owned > hello.txt', cwd: CWD }).action,
    ).toBe('ask');
  });
});

/* ------------------------- workspace boundary --------------------------- */

describe('ATTACK: acceptEdits + write/apply_patch outside the workspace', () => {
  let dir: string;
  let orchestrator: ToolOrchestrator;
  let approvals: unknown[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smalt-sec-'));
    approvals = [];
    const permissions = svc(['edit:src/**'], undefined, 'acceptEdits');
    orchestrator = new ToolOrchestrator({
      tools: new ToolRegistry(defaultTools()),
      permissions,
      hooks: new HookBus(() => {}),
      requestApproval: async (req) => {
        approvals.push(req);
        return { decision: 'deny' };
      },
      askUser: async () => '',
      log: () => {},
    });
  });

  const ctx = (dir: string) => ({
    cwd: dir,
    threadId: 'th_sec',
    turnId: 'turn_sec',
    itemId: 'item_sec',
    signal: new AbortController().signal,
    log: () => {},
  });

  it('blocks write ../escape even under acceptEdits, writes nothing', async () => {
    const out = await orchestrator.execute('c1', 'write', { path: '../pwned.txt', content: 'pwn' }, ctx(dir));
    expect(out.denied).toBe(true);
    expect(out.output).toContain('workspace');
    expect(existsSync(join(dir, '..', 'pwned.txt'))).toBe(false);
  });

  it('blocks absolute paths outside the workspace', async () => {
    const outside = join(tmpdir(), 'smalt-escape-target.txt');
    const out = await orchestrator.execute('c2', 'write', { path: outside, content: 'x' }, ctx(dir));
    expect(out.denied).toBe(true);
  });

  it('blocks apply_patch with a ../ Move target', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const patch = '*** Begin Patch\n*** Update File: a.txt\n*** Move to: ../stolen.txt\n@@\n-a\n+b\n*** End Patch';
    const out = await orchestrator.execute('c3', 'apply_patch', { patch }, ctx(dir));
    expect(out.denied).toBe(true);
    expect(existsSync(join(dir, '..', 'stolen.txt'))).toBe(false);
  });

  it('still allows in-workspace writes under acceptEdits', async () => {
    const out = await orchestrator.execute('c4', 'write', { path: 'src/ok.ts', content: 'x' }, ctx(dir));
    expect(out.denied).toBe(false);
    expect(existsSync(join(dir, 'src/ok.ts'))).toBe(true);
  });
});

describe('ATTACK: deny rules dodged via multi-file patches and backslash paths', () => {
  let dir: string;
  let orchestrator: ToolOrchestrator;
  let approvals: unknown[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smalt-sec2-'));
    approvals = [];
    const permissions = svc(['edit:src/**'], ['edit:.env'], 'acceptEdits');
    orchestrator = new ToolOrchestrator({
      tools: new ToolRegistry(defaultTools()),
      permissions,
      hooks: new HookBus(() => {}),
      requestApproval: async (req) => {
        approvals.push(req);
        return { decision: 'deny' };
      },
      askUser: async () => '',
      log: () => {},
    });
  });

  const ctx = () => ({
    cwd: dir,
    threadId: 'th_sec',
    turnId: 'turn_sec',
    itemId: 'item_sec',
    signal: new AbortController().signal,
    log: () => {},
  });

  it('denies a patch that smuggles .env next to an allowed src file', async () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: .env\n+SECRET=1\n*** End Patch';
    const out = await orchestrator.execute('c1', 'apply_patch', { patch }, ctx());
    expect(out.denied).toBe(true);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('denies backslash-relative paths that resolve to the denied file', async () => {
    const patch =
      '*** Begin Patch\n*** Add File: .\\\\..\\\\.env\n+x\n*** End Patch';
    const out = await orchestrator.execute('c2', 'apply_patch', { patch }, ctx());
    // .\..\.env resolves outside-normal → either workspace-denied or rule-denied
    expect(out.denied).toBe(true);
  });

  it('denies backslash paths under a nested deny glob', async () => {
    const permissions = svc(['edit:src/**'], ['edit:**/secrets/**'], 'acceptEdits');
    const orch = new ToolOrchestrator({
      tools: new ToolRegistry(defaultTools()),
      permissions,
      hooks: new HookBus(() => {}),
      requestApproval: async () => ({ decision: 'deny' }),
      askUser: async () => '',
      log: () => {},
    });
    const patch = '*** Begin Patch\n*** Add File: sub\\\\secrets\\\\key.pem\n+x\n*** End Patch';
    const out = await orch.execute('c3', 'apply_patch', { patch }, ctx());
    expect(out.denied).toBe(true);
  });

  it('plain allowed multi-file patches still pass', async () => {
    const patch =
      '*** Begin Patch\n*** Add File: src/a.ts\n+1\n*** Add File: src/b.ts\n+2\n*** End Patch';
    const out = await orchestrator.execute('c4', 'apply_patch', { patch }, ctx());
    expect(out.denied).toBe(false);
    expect(approvals).toHaveLength(0);
  });
});

/* --------------------------- rule-matching units ------------------------ */

describe('path normalization against dodge attempts', () => {
  it('matches rules through ./ and .. and mixed separators', () => {
    const s = svc(undefined, ['edit:.env']);
    for (const subject of ['.env', './.env', '.\\.env', `sub/../.env`]) {
      expect(s.check({ tool: 'write', input: {}, subject, cwd: CWD }).action).toBe('deny');
    }
  });
});
