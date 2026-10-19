import { describe, expect, it } from 'vitest';
import { operationIssues } from '../src/renderer/src/c/issues';
import type { Item } from '../src/renderer/src/bridge';
const command = (output: string, extra = {}): Item => ({ id: 'cmd', threadId: 'thread', turnId: 'turn', createdAt: '', kind: 'commandExecution', command: 'run command', tool: 'shell', output, exitCode: 1, status: 'failed', ...extra });
describe('actual operation failure reasons', () => {
  it('surfaces missing commands and quoting failures instead of a whole output dump', () => {
    expect(operationIssues([command("[exit 1]\n'head' is not recognized as an internal or external command.\noperable program or batch file.")])[0]).toMatchObject({ reason: "'head' is not recognized as an internal or external command.", hint: expect.stringContaining('当前终端') });
    expect(operationIssues([command('Traceback\n  File <string>\nSyntaxError: unterminated string literal')])[0]).toMatchObject({ reason: 'SyntaxError: unterminated string literal', hint: expect.stringContaining('引号') });
  });
  it('extracts the missing path from long test output and preserves the raw record', () => {
    const output = '.'.repeat(1000) + "\nTraceback...\nE FileNotFoundError: [Errno 2] No such file or directory: 'backend/resource.json'\nE ValueError: unreadable\n1 failed, 1820 passed";
    const issue = operationIssues([command(output)])[0]!;
    expect(issue.reason).toContain("'backend/resource.json'"); expect(issue.hint).toContain('工作目录'); expect(issue.output).toBe(output);
  });
  it('does not mark successful stderr as a failure and keeps blocked/cancelled records distinct', () => {
    expect(operationIssues([command('Warning: Error: ignored test fixture', { status: 'completed', exitCode: 0 })])).toEqual([]);
    expect(operationIssues([command('User denied', { status: 'blocked' })])[0]).toMatchObject({ blocked: true, reason: 'User denied' });
    expect(operationIssues([command('[exit ?] [interrupted]')])[0].reason).toContain('中断');
  });
  it('shows check findings, skipped checks and masked failures independently of the exit badge', () => {
    expect(operationIssues([command('[exit 1]\nWould reformat: a.py', { command: 'ruff format --check .' })])[0]).toMatchObject({ kind: 'finding', reason: 'Would reformat: a.py' });
    expect(operationIssues([command('[exit 0]\n1 failed', { command: 'pnpm test & echo EXIT_CODE=0', exitCode: 0, status: 'completed' })])[0]).toMatchObject({ kind: 'unverified', reason: expect.stringContaining('返回 0') });
    expect(operationIssues([command('[exit 0]\n115 skipped', { command: 'pytest', exitCode: 0, status: 'completed' })])[0]).toMatchObject({ kind: 'unverified' });
  });
  it('folds a confirmed retry without erasing its original output or suite findings', () => {
    const first = command('[exit 1]\n1 failed', { id: 'suite', command: 'pnpm test' });
    const single = command('[exit 0]\n1 passed', { id: 'single', command: 'pnpm test Cover.test.tsx', exitCode: 0, status: 'completed' });
    expect(operationIssues([first, single]).map(i => i.id)).toEqual(['suite']);
    expect(operationIssues([first, command('[exit 0]\n41 passed', { id: 'rerun', command: 'pnpm test', exitCode: 0, status: 'completed' })])).toEqual([]);
    expect(first.kind === 'commandExecution' && first.output).toContain('1 failed');
  });
});
