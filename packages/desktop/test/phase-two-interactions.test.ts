import { describe, expect, it } from 'vitest';
import { searchConversation } from '../src/renderer/src/c/conversation-search';
import { inspectReferences } from '../src/main/context-inspection';
import type { Item } from '../src/renderer/src/bridge';

const base = { threadId: 'th1', turnId: 't1', createdAt: '', status: 'completed' as const };
describe('conversation search and context inspection contracts', () => {
  it('finds old message, folded command output, references and file records by scope without regex execution', async () => {
    const items: Item[] = [
      { ...base, id: 'old', kind: 'userMessage', text: '较早的中文说明', references: [{ path: 'docs/a.md' }] },
      { ...base, id: 'cmd', kind: 'commandExecution', command: 'node check', output: 'Error: 缺少配置 [a-z]+', exitCode: 1, status: 'failed' },
      { ...base, id: 'file', kind: 'fileChange', path: 'docs/配置.md', changeKind: 'add' },
    ];
    expect((await searchConversation(items, [], '中文', 'all')).hits[0]!.id).toBe('old');
    expect((await searchConversation(items, [], 'docs/a', 'messages')).hits[0]!.id).toBe('old');
    expect((await searchConversation(items, [], '[a-z]+', 'execution')).hits[0]!.id).toBe('cmd');
    expect((await searchConversation(items, [], '配置', 'files')).hits.map(hit => hit.id)).toEqual(['file']);
    const issue = { id: 'cmd', title: 'check', reason: '缺少配置', hint: '', output: 'Error: 缺少配置', blocked: false, kind: 'error' as const };
    expect((await searchConversation(items, [issue], '配置', 'issues')).hits.map(hit => hit.id)).toEqual(['cmd']);
  });
  it('caps result size, yields for large histories and cancels stale searches', async () => {
    const items: Item[] = Array.from({ length: 2000 }, (_, i) => ({ ...base, id: String(i), kind: 'agentMessage', text: 'record needle ' + i }));
    const result = await searchConversation(items, [], 'needle', 'all'); expect(result.hits).toHaveLength(200); expect(result.truncated).toBe(true);
    const controller = new AbortController();
    const pending = searchConversation(items, [], 'missing', 'all', controller.signal); controller.abort();
    expect((await pending).hits).toEqual([]);
  });
  it('reports exact selected scope, source, truncation and changed versions independently', async () => {
    const text = '第一行\n选择😀这一段\n保留'; const start = text.indexOf('选择'), end = text.indexOf('\n保留');
    const refs = [{ path: 'a.md', digest: 'v1', start, end }, { path: 'large.md' }, { path: 'changed.md', digest: 'v0' }, { path: 'missing.md' }];
    const result = await inspectReferences(refs, async ref => {
      if (ref.path === 'missing.md') throw new Error('文件不存在');
      return { text: ref.path === 'large.md' ? 'x'.repeat(25000) : text, digest: 'v1', source: ref.path, label: ref.path, format: 'text' };
    });
    expect(result[0]).toMatchObject({ valid: true, selected: true, startLine: 2, endLine: 2, excerpt: '选择😀这一段' });
    expect(result[1]).toMatchObject({ valid: true, truncated: true, characters: 24000, totalCharacters: 25000 });
    expect(result[1]!.excerpt).toHaveLength(3200);
    expect(result[2]).toMatchObject({ valid: false, digest: 'v1' }); expect(result[2]!.error).toContain('来源已变化');
    expect(result[3]).toMatchObject({ valid: false, error: '文件不存在' });
  });
});
