import { describe, expect, it } from 'vitest';
import { assessTurn, executionAssessment, missingProgram, operationAssessments, verifiesSameCheck } from '../src/protocol/assessment.js';
import type { Item } from '../src/protocol/types.js';
const cmd = (id: string, command: string, output: string, exitCode: number): Item => ({ kind: 'commandExecution', id, threadId: 't', turnId: 'turn', createdAt: '', command, output, exitCode, status: exitCode ? 'failed' : 'completed', tool: 'shell' });
describe('evidence-based execution and completion', () => {
  it('separates check findings from runner/configuration errors', () => {
    expect(executionAssessment('ruff format --check .', 'Would reformat: a.py\n1 file would be reformatted', 1)).toMatchObject({ kind: 'finding', check: 'format', exitCode: 1 });
    expect(executionAssessment('ruff format --check .', 'error: Failed to parse configuration', 2).kind).toBe('error');
    expect(executionAssessment('pnpm exec vitest run', '1 failed | 41 passed\nTestingLibraryElementError: missing element', 1).kind).toBe('finding');
    expect(executionAssessment('pnpm exec vitest run', 'Unknown option --run', 1)).toMatchObject({ kind: 'error', code: 'invalidInvocation' });
    expect(executionAssessment('pytest', 'pytest: command not found', 127).code).toBe('commandUnavailable');
    expect(executionAssessment('node script.cjs', 'Error: expected fixture', 0).kind).toBe('success');
    expect(executionAssessment('node -e "console.log(\'pnpm test 1 failed\')"', 'pnpm test 1 failed', 0).kind).toBe('success');
  });
  it('keeps the actual code and flags masked/conflicting exit status', () => {
    expect(executionAssessment('pnpm test & echo EXIT_CODE=%ERRORLEVEL%', '1 failed\nEXIT_CODE=0', 0)).toMatchObject({ kind: 'unverified', exitCode: 0, code: 'exitCodeConflict' });
    expect(executionAssessment('pnpm test | tail -n 10', 'end of output', 0)).toMatchObject({ kind: 'unverified', code: 'shellStatusMasked' });
    expect(executionAssessment('pnpm test --name "literal & echo hi"', '41 passed', 0).kind).toBe('success');
    expect(executionAssessment('pytest', '115 skipped', 0)).toMatchObject({ kind: 'unverified', skipped: 115 });
    expect(executionAssessment('pnpm test', '[timed out]\n1 failed', 0)).toMatchObject({ kind: 'error', code: 'timeout' });
    expect(executionAssessment('pnpm test', '[interrupted]', null).kind).toBe('interrupted');
  });
  it('does not let an isolated test erase a full-suite failure', () => {
    const items = [cmd('suite', 'pnpm exec vitest run', '1 failed', 1), cmd('single', 'pnpm exec vitest run Cover.test.tsx', '1 passed', 0)];
    expect(operationAssessments(items).get('suite')?.recoveredBy).toBeUndefined();
    expect(assessTurn(items, '只检查，禁止修改')).toMatchObject({ status: 'findings', checks: { passed: 1, findings: 1 } });
    expect(assessTurn(items, '修复项目')).toMatchObject({ status: 'needsAttention' });
    expect(assessTurn([...items, { kind: 'userMessage', id: 'steer', threadId: 't', turnId: 'turn', createdAt: '', status: 'completed', text: '现在只检查，禁止修改。' }], '修复项目').status).toBe('findings');
    expect(assessTurn(items, '修复项目，不要修改其他文件。').status).toBe('needsAttention');
  });
  it('requires the same check, exact scope, cwd and trustworthy process result for explicit recovery', () => {
    const prior = { command: 'pnpm test 2>&1 & echo EXIT_CODE=%ERRORLEVEL%', assessment: executionAssessment('pnpm test 2>&1 & echo EXIT_CODE=%ERRORLEVEL%', '1 failed', 0, 'shell', '/work') };
    const next = { command: 'pnpm test', assessment: executionAssessment('pnpm test', '41 passed', 0, 'process', '/work') };
    expect(verifiesSameCheck(prior, next)).toBe(true);
    expect(verifiesSameCheck(prior, { ...next, command: 'pnpm test Cover.test.tsx' })).toBe(false);
    expect(verifiesSameCheck(prior, { ...next, assessment: { ...next.assessment, kind: 'unverified', skipped: 4 } })).toBe(false);
    expect(verifiesSameCheck(prior, { ...next, assessment: executionAssessment('pnpm test', '41 passed', 0, 'process', '/other') })).toBe(false);
    expect(verifiesSameCheck({ ...prior, command: 'cd frontend & pnpm test & echo done' }, next)).toBe(false);
    expect(verifiesSameCheck({ ...prior, command: 'pnpm test & node unrelated.cjs' }, next)).toBe(false);
    expect(verifiesSameCheck({ ...prior, command: 'pnpm test & echo done & node unrelated.cjs' }, next)).toBe(false);
    expect(missingProgram("'grep' is not recognized as an internal or external command")).toBe('grep');
    expect(missingProgram('/bin/sh: 1: grep: not found')).toBe('grep');
    expect(missingProgram('bash: head: command not found')).toBe('head');
    expect(missingProgram("'other' is not recognized as an internal command\ngrep was present")).toBe('other');
  });
  it('links identical successful retries in the same turn, preserves failed and cross-turn evidence', () => {
    const items = [cmd('bad', 'pnpm test', '1 failed', 1), cmd('good', 'pnpm test', '41 passed', 0)];
    expect(operationAssessments(items).get('bad')).toMatchObject({ kind: 'finding', recoveredBy: 'good' });
    expect(assessTurn(items, '修复')).toMatchObject({ status: 'completed', recovered: 1, checks: { findings: 0, passed: 1 } });
    expect(operationAssessments([items[0]!, { ...items[1]!, turnId: 'other' }]).get('bad')?.recoveredBy).toBeUndefined();
    expect(assessTurn([cmd('skip', 'pytest', '115 skipped', 0)], '检查')).toMatchObject({ status: 'unverified', checks: { skipped: 115 } });
  });
  it('does not equate a stopped or unfinished plan with completed work', () => {
    const plan: Item = { kind: 'plan', id: 'p', threadId: 't', turnId: 'turn', createdAt: '', status: 'completed', steps: [{ content: 'verify suite', status: 'inProgress' }] };
    expect(assessTurn([plan], '修复')).toMatchObject({ status: 'needsAttention', pendingSteps: 1 });
    expect(assessTurn([plan], '修复', true).status).toBe('interrupted');
    const file: Item = { kind: 'fileChange', id: 'f', threadId: 't', turnId: 'turn', createdAt: '', status: 'completed', path: 'app.py', changeKind: 'update' };
    expect(assessTurn([file], '修复')).toMatchObject({ status: 'unverified', verificationMissing: true });
    expect(assessTurn([{ ...file, path: 'README.md' }], '修改说明').status).toBe('completed');
  });
});
