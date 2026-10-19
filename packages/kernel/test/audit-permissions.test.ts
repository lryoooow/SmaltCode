import { describe, expect, it } from 'vitest';
import { dangerousCommandCheck, commandAllowedBy, commandMatchesAny, parseRule, splitCommand } from '../src/permissions/rules.js';
import { PermissionService } from '../src/permissions/service.js';
import { ToolOrchestrator } from '../src/tools/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { HookBus } from '../src/hooks/bus.js';
import { shellTool } from '../src/tools/defs/shell.js';

const dangerous = ['rm -rf /', 'rm -rf /*', 'rm -r -f /', 'rm --recursive --force /usr/*', 'rm -rf ~/*', 'rm -rf $HOME/*', 'rm -rf "${HOME}/*"', 'bash -c "rm -rf /*"', 'Remove-Item -Recurse -Force C:\\', 'Remove-Item -LiteralPath "C:\\Windows\\Temp" -Recurse', 'rd /s /q C:\\', 'del /s C:\\*', 'powershell -EncodedCommand AAAA'];
const input = (command: string) => ({ tool: 'shell', subject: command, input: { command }, cwd: process.cwd() });
describe('audit: dangerous commands and read-only authority', () => {
  it('applies high-risk and deny rules to structured argv without executing it', () => {
    const permissions = new PermissionService([], [parseRule('shell:*', 'user')], []); permissions.setMode('bypassPermissions'); permissions.allowCategory('shell');
    for (const value of [{ program: 'rm', args: ['-rf', '/'] }, { program: 'format', args: ['C:'] }]) {
      expect(permissions.check({ tool: 'shell', input: value, subject: shellTool.subject(value), subjects: shellTool.subjects!(value), cwd: process.cwd() }).action).toBe('ask');
    }
    expect(permissions.check({ ...input('echo safe'), subjects: ['echo safe', 'rm -rf /'] }).action).toBe('ask');
    const denied = new PermissionService([parseRule('shell:git push', 'user')], [parseRule('shell:*', 'user')], []);
    const value = { program: 'git', args: ['push', 'origin', 'main'] };
    expect(denied.check({ tool: 'shell', input: value, subject: shellTool.subject(value), subjects: shellTool.subjects!(value), cwd: process.cwd() }).action).toBe('deny');
    const absolute = { ...value, program: 'C:/Program Files/Git/bin/git.exe' };
    expect(denied.check({ tool: 'shell', input: absolute, subject: shellTool.subject(absolute), subjects: shellTool.subjects!(absolute), cwd: process.cwd() }).action).toBe('deny');
  });
  it.each(dangerous)('requires explicit approval despite broad/category grants: %s', command => {
    expect(dangerousCommandCheck(command).dangerous).toBe(true);
    const permissions = new PermissionService([], [parseRule('shell:*', 'user')], []);
    permissions.allowCategory('shell'); permissions.setMode('bypassPermissions');
    expect(permissions.check(input(command)).action).toBe('ask');
    permissions.setMode('plan'); expect(permissions.check(input(command)).action).toBe('deny');
    permissions.setMode('dontAsk'); expect(permissions.check(input(command)).action).toBe('deny');
  });
  it('never executes a plan-mode shell even if the approval callback would allow it', async () => {
    let executions = 0, approvals = 0;
    const permissions = new PermissionService([], [], []); permissions.setMode('plan');
    const tools = new ToolRegistry([{ name: 'shell', description: '', inputSchema: { type: 'object' }, subject: () => 'rm -rf /', summarize: () => '', async *run() { executions++; yield { type: 'result', text: 'fake' }; } }]);
    const orchestrator = new ToolOrchestrator({ tools, permissions, hooks: new HookBus(), requestApproval: async () => { approvals++; return { decision: 'allow' }; }, askUser: async () => '', log() {} });
    const result = await orchestrator.execute('test', 'shell', { command: 'rm -rf /' }, { cwd: process.cwd(), threadId: 't', turnId: 'turn', signal: new AbortController().signal });
    expect(result.denied).toBe(true); expect(result.output).toContain('Plan mode'); expect(executions).toBe(0); expect(approvals).toBe(0);
  });
  it('allows descriptor duplication and quoted comparison text while retaining file-write/chaining checks', () => {
    expect(splitCommand('npm test 2>&1')).toEqual(['npm test 2>&1']);
    expect(commandAllowedBy('npm test', 'npm test 2>&1')).toBe(true);
    expect(commandAllowedBy('npm test', 'npm test 1>&2')).toBe(true);
    expect(commandAllowedBy('grep', 'grep "a>b"')).toBe(true);
    expect(commandAllowedBy('npm test', 'npm test > output.txt')).toBe(false);
    expect(commandAllowedBy('npm test', 'npm test 2>&1& whoami')).toBe(false);
    expect(commandMatchesAny('npm publish', 'bash -c "npm publish"')).toBe(true);
    expect(commandMatchesAny('npm publish', 'cmd /c "npm publish"')).toBe(true);
  });
});
