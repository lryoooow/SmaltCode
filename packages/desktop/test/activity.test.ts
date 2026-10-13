import { describe, expect, it } from 'vitest';
import { activityProgress, activityTimeline } from '../src/renderer/src/c/activity';
import type { Item } from '../src/renderer/src/bridge';

const base = { threadId: 'thread', turnId: 'turn', createdAt: '', status: 'completed' as const };
const reasoning = (id: string): Item => ({ ...base, id, kind: 'reasoning', text: '分析任务' });
const command = (id: string, tool = 'shell', status: Item['status'] = 'completed'): Item => ({ ...base, id, kind: 'commandExecution', tool, command: 'technical details', output: 'output', exitCode: status === 'inProgress' ? null : 0, status });
const file = (id: string, path = 'result.md', status: Item['status'] = 'completed'): Item => ({ ...base, id, kind: 'fileChange', path, status, changeKind: 'update' });
const message = (id: string, kind: 'userMessage' | 'agentMessage', text = '消息'): Item => ({ ...base, id, kind, text });

describe('conversation activity presentation', () => {
  it('combines repeated reasoning, plans, reads, commands and edits into one stable group', () => {
    const first = command('first', 'write', 'inProgress');
    expect(activityTimeline([first])[0]).toMatchObject({ id: 'first' });
    const items = [file('first'), reasoning('r'), { ...base, id: 'plan', kind: 'plan', steps: [] } as Item, command('read', 'read'), command('shell')];
    expect(activityTimeline(items)).toEqual([{ kind: 'activity', id: 'first', turnId: 'turn', items }]);
  });
  it('preserves progress replies, user steering and questions outside the folded groups', () => {
    const items: Item[] = [message('u', 'userMessage'), reasoning('r1'), message('a', 'agentMessage', '已核对资料，开始生成文件'), command('c1'), message('steer', 'userMessage'), reasoning('r2'), { ...base, id: 'q', kind: 'userInputRequest', question: '选择语言' }, file('f')];
    const timeline = activityTimeline(items);
    expect(timeline.map(e => e.kind === 'message' ? e.item.id : e.id)).toEqual(['u', 'r1', 'a', 'c1', 'steer', 'r2', 'q', 'f']);
    expect(timeline.flatMap(e => e.kind === 'message' ? [e.item] : e.items)).toEqual(items);
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
    expect(progress.warnings).toBe('1 项操作被阻止，1 项操作失败');
    expect(progress.label).toBe('部分操作未完成');
  });
  it.each([['read', '正在读取资料'], ['write', '正在生成文件'], ['shell', '正在执行操作'], ['apply_patch', '正在更新文件']])('describes a live %s operation without exposing its command', (tool, label) => {
    const progress = activityProgress([command('c', tool, 'inProgress')], { running: true, lifecycle: 'running' });
    expect(progress.label).toBe(label);
    expect(progress.milestones).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain('technical details');
  });
  it('prioritizes required user action over a pending tool and distinguishes cancellation', () => {
    const items = [command('c', 'write', 'inProgress')];
    expect(activityProgress(items, { running: true, lifecycle: 'waitingForPermission' }).label).toBe('等待你确认操作');
    expect(activityProgress(items, { running: true, lifecycle: 'waitingForUser' }).label).toBe('等待你的回答');
    expect(activityProgress([command('c', 'shell', 'failed')], { interrupted: true })).toMatchObject({ label: '已停止', warnings: '1 项操作未完成' });
  });
  it('keeps actual assistant replies visible and marks only live generation as replying', () => {
    const reply = { ...message('a', 'agentMessage'), status: 'inProgress' as const };
    expect(activityProgress([command('c'), reply], { running: true }).label).toBe('正在组织回复');
    expect(activityTimeline([command('c'), reply]).at(-1)).toEqual({ kind: 'message', item: reply });
  });
});
