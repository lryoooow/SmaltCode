import { describe, expect, it } from 'vitest';
import { activityProgress, activityTimeline, latestPlan, planProgress } from '../src/renderer/src/c/activity';
import type { Item } from '../src/renderer/src/bridge';

const base = { threadId: 'thread', turnId: 'turn', createdAt: '', status: 'completed' as const };
const reasoning = (id: string): Item => ({ ...base, id, kind: 'reasoning', text: '分析任务' });
const command = (id: string, tool = 'shell', status: Item['status'] = 'completed'): Item => ({ ...base, id, kind: 'commandExecution', tool, command: 'technical details', output: 'output', exitCode: status === 'inProgress' ? null : 0, status });
const file = (id: string, path = 'result.md', status: Item['status'] = 'completed'): Item => ({ ...base, id, kind: 'fileChange', path, status, changeKind: 'update' });
const message = (id: string, kind: 'userMessage' | 'agentMessage', text = '消息'): Item => ({ ...base, id, kind, text });

describe('conversation activity presentation', () => {
  it('groups records without putting plan revisions inside execution details', () => {
    const first = command('first', 'write', 'inProgress');
    expect(activityTimeline([first])[0]).toMatchObject({ id: 'first' });
    const items = [file('first'), reasoning('r'), { ...base, id: 'plan', kind: 'plan', steps: [] } as Item, command('read', 'read'), command('shell')];
    expect(activityTimeline(items, 'turn')).toEqual([{ kind: 'activity', id: 'first', turnId: 'turn', items: items.filter(i => i.kind !== 'plan') }]);
  });
  it('preserves progress replies, user steering and questions outside the folded groups', () => {
    const items: Item[] = [message('u', 'userMessage'), reasoning('r1'), message('a', 'agentMessage', '已核对资料，开始生成文件'), command('c1'), message('steer', 'userMessage'), reasoning('r2'), { ...base, id: 'q', kind: 'userInputRequest', question: '选择语言' }, file('f')];
    const timeline = activityTimeline(items);
    expect(timeline.map(e => e.kind === 'activity' ? e.id : e.item.id)).toEqual(['u', 'r1', 'a', 'c1', 'steer', 'r2', 'q', 'f']);
    expect(timeline.flatMap(e => e.kind === 'activity' ? e.items : [e.item])).toEqual(items);
  });
  it('never merges separate turns or lets an empty streaming placeholder split work', () => {
    const old = reasoning('old');
    const next = { ...reasoning('next'), turnId: 'next-turn' };
    expect(activityTimeline([old, message('empty', 'agentMessage', ''), command('c'), next])).toHaveLength(2);
  });
  it('reports completed milestones without counting pending, failed or blocked work as success', () => {
    const failed: Item = { ...command('fail'), kind: 'commandExecution', exitCode: 1 };
    const progress = activityProgress([command('read', 'read'), command('pending', 'read', 'inProgress'), failed, file('f'), file('f2'), file('denied', 'secret', 'blocked')]);
    expect(progress.milestones).toEqual(['已读取 1 项资料', '已更新 1 个文件']);
    expect(progress.issueCount).toBe(2);
    expect(progress.warnings).toBe('1 项操作被阻止 · 1 项执行需处理');
    expect(progress.label).toBe('有结果需查看');
  });
  it.each([['read', '正在读取资料'], ['write', '正在生成文件'], ['shell', '正在执行命令'], ['apply_patch', '正在更新文件']])('describes a live %s operation without exposing its command', (tool, label) => {
    const progress = activityProgress([command('c', tool, 'inProgress')], { running: true, lifecycle: 'running' });
    expect(progress.label).toBe(label);
    expect(progress.milestones).toEqual([]);
    if (tool === 'shell') expect(progress.detail).toBeUndefined();
  });
  it('selects only the latest plan snapshot and keeps historical plans outside records', () => {
    const first: Extract<Item, { kind: 'plan' }> = { ...base, kind: 'plan', id: 'p1', steps: [{ content: '已完成', status: 'completed' }, { content: '当前步骤', status: 'inProgress' }, { content: '后续', status: 'pending' }] };
    const final = { ...first, id: 'p2', steps: first.steps.map(s => ({ ...s, status: 'completed' as const })) };
    expect(latestPlan([first, final], 'turn')).toBe(final);
    expect(planProgress(first)).toMatchObject({ done: 1, total: 3, index: 1, complete: false });
    expect(planProgress(final)).toMatchObject({ done: 3, total: 3, current: undefined, complete: true });
    expect(activityTimeline([first, final, { ...reasoning('new'), turnId: 'next' }], 'next')[0]).toEqual({ kind: 'plan', item: final });
    expect(latestPlan([first, { ...final, steps: [] }], 'turn')).toBeUndefined();
    expect(latestPlan([first], 'next')).toBeUndefined();
    expect(activityProgress([first, final]).milestones).toEqual([]);
  });
  it('shows a concrete live action and a trustworthy last completed node without exposing inline code', () => {
    const read = { ...command('r', 'read'), command: 'read D:\\project\\README.md' };
    const active = { ...command('c', 'shell', 'inProgress'), command: 'npm test' };
    expect(activityProgress([read, active], { running: true, cwd: 'D:\\project' })).toMatchObject({ label: '正在运行测试', detail: 'npm', recent: '已读取 README.md' });
    expect(activityProgress([{ ...active, command: 'node -e "secretInlineCode()"' }], { running: true }).detail).toBe('Node.js 程序');
    expect(activityProgress([read, { ...file('f'), status: 'failed' }], { running: true }).recent).toBe('已读取 D:/project/README.md');
  });
  it('prioritizes required user action over a pending tool and distinguishes cancellation', () => {
    const items = [command('c', 'write', 'inProgress')];
    expect(activityProgress(items, { running: true, lifecycle: 'waitingForPermission' }).label).toBe('等待你确认操作');
    expect(activityProgress(items, { running: true, lifecycle: 'waitingForUser' }).label).toBe('等待你的回答');
    expect(activityProgress([command('c', 'shell', 'failed')], { interrupted: true })).toMatchObject({ label: '已停止', warnings: '1 项执行需处理' });
  });
  it('keeps actual assistant replies visible and marks only live generation as replying', () => {
    const reply = { ...message('a', 'agentMessage'), status: 'inProgress' as const };
    expect(activityProgress([command('c'), reply], { running: true }).label).toBe('正在组织回复');
    expect(activityTimeline([command('c'), reply]).at(-1)).toEqual({ kind: 'message', item: reply });
  });
});
