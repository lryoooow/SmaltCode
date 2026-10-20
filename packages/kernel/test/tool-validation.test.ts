import { expect, it } from 'vitest';
import { validateInput } from '../src/tools/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
const tools = new ToolRegistry();
const valid = (name: string, input: unknown) => validateInput(tools.get(name)!.inputSchema, input);
it('rejects malformed nested plans with the exact failing field before tool execution', () => {
  for (const input of [{ steps: [null] }, { steps: [{}] }, { steps: [{ content: '工作', status: 'bogus' }] }, { steps: [{ content: 123, status: 'pending' }] }]) expect(valid('plan', input).ok).toBe(false);
  expect(valid('plan', { steps: [null] })).toMatchObject({ error: expect.stringContaining('$.steps[0]') });
  expect(valid('plan', { steps: [] }).ok).toBe(true);
  expect(valid('plan', { steps: [{ content: '核对资料', status: 'inProgress' }] }).ok).toBe(true);
});
it('bounds plans, question choices, integer offsets and shell arguments', () => {
  expect(valid('plan', { steps: Array.from({ length: 201 }, () => ({ content: 'x', status: 'pending' })) }).ok).toBe(false);
  expect(valid('ask_user', { question: '问题', options: [123] }).ok).toBe(false);
  expect(valid('shell', { program: 'node', args: ['literal', null] }).ok).toBe(false);
  expect(valid('shell', { timeoutMs: 0 }).ok).toBe(false);
  expect(valid('read', { path: 'a', offset: 1.5 }).ok).toBe(false);
  expect(valid('read', { path: 'a', limit: -1 }).ok).toBe(false);
});
it('rejects non-JSON/cyclic/too-deep data and finite-number violations without crashing', () => {
  const cycle: any = {}; cycle.child = cycle;
  for (const input of [cycle, { child: new Date() }, { value: Infinity }, { value: undefined }]) expect(validateInput({ type: 'object' }, input).ok).toBe(false);
  let deep: any = {}; for (let i = 0; i < 40; i++) deep = { child: deep }; expect(validateInput({}, deep).ok).toBe(false);
  expect(validateInput({}, { text: 'x'.repeat(4 * 1024 * 1024 + 1) }).ok).toBe(false);
});
it('supports explicit additional-property rules and does not accept inherited required fields', () => {
  expect(validateInput({ type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } }, { path: 'ok', extra: 1 }).ok).toBe(false);
  expect(validateInput({ required: ['path'] }, Object.create({ path: 'inherited' })).ok).toBe(false);
  expect(valid('shell', { program: 'node', args: ['--version'], recoveryOf: 'call-1' }).ok).toBe(true);
});
