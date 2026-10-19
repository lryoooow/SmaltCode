import { expect, it } from 'vitest';
import { budgetToolOutput, unifiedDiff } from '../src/util.js';
import { ToolOrchestrator } from '../src/tools/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { HookBus } from '../src/hooks/bus.js';
import { PermissionService } from '../src/permissions/service.js';
it('groups distant changes into independent hunks', () => {
  const before = Array.from({ length: 1000 }, (_, i) => 'line ' + i), after = [...before];
  after[0] = 'first changed'; after[999] = 'last changed';
  const diff = unifiedDiff('test.ts', before, after);
  expect(diff.match(/^@@ /gm)).toHaveLength(2); expect(diff.split('\n').length).toBeLessThan(30);
  expect(diff).toContain('-line 0\n+first changed'); expect(diff).toContain('-line 999\n+last changed');
  expect(diff).not.toContain('-line 500');
  const one = [...before]; one[500] = 'changed'; expect(unifiedDiff('test.ts', before, one).split('\n').length).toBeLessThan(20);
  expect(unifiedDiff('same.ts', before, before)).toBe('');
});
it('retains both ends of an output within a strict context budget', () => {
  const output = budgetToolOutput('HEADER\n' + 'x'.repeat(100000) + '\nERROR: actual failure');
  expect(output.length).toBeLessThanOrEqual(24000); expect(output).toContain('HEADER'); expect(output).toContain('ERROR: actual failure'); expect(output).toContain('已省略');
});
it('streams a large output with bounded retained deltas and preserves the terminal failure', async () => {
  let streamed = 0;
  const tools = new ToolRegistry([{ name: 'read', description: '', inputSchema: { type: 'object' }, subject: () => '.', summarize: () => 'fixture', async *run() {
    for (let i = 0; i < 1000; i++) yield { type: 'output', text: 'x'.repeat(2000) };
    yield { type: 'result', text: 'Final diagnostic: source unavailable', isError: true, assessment: { kind: 'error', summary: 'Source unavailable' } };
  } }]);
  const orchestrator = new ToolOrchestrator({ tools, hooks: new HookBus(), permissions: new PermissionService([], [], []), requestApproval: async () => ({ decision: 'deny' }), askUser: async () => '', onOutput: (_thread, _id, text) => { streamed += text.length; }, log() {} });
  const result = await orchestrator.execute('call', 'read', {}, { cwd: process.cwd(), threadId: 't', turnId: 'turn', itemId: 'call', signal: new AbortController().signal, log() {} });
  expect(streamed).toBe(2_000_000); expect(result.deltas.join('').length).toBeLessThanOrEqual(30000);
  expect(result).toMatchObject({ isError: true, output: 'Final diagnostic: source unavailable', assessment: { kind: 'error' } });
});
