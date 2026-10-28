import type { Item } from '../bridge'
import type { OperationIssue } from './issues'

export type SearchScope = 'all' | 'messages' | 'execution' | 'files' | 'issues'
export type ConversationHit = { id: string; title: string; snippet: string; kind: SearchScope; start: number; end: number }
function searchable(item: Item): { title: string; text: string; kind: SearchScope } {
  switch (item.kind) {
    case 'userMessage': return { title: '你的消息', text: item.text + (item.references?.map(ref => '\n' + (ref.label ?? '') + ' ' + ref.path).join('') ?? ''), kind: 'messages' }
    case 'agentMessage': return { title: '回复', text: item.text, kind: 'messages' }
    case 'fileChange': return { title: item.path, text: item.path + '\n' + (item.diff ?? ''), kind: 'files' }
    case 'commandExecution': return { title: item.command, text: item.command + '\n' + item.output, kind: 'execution' }
    case 'reasoning': return { title: '思考记录', text: item.text, kind: 'execution' }
    case 'plan': return { title: '执行计划', text: item.steps.map(step => step.content).join('\n'), kind: 'execution' }
    case 'mcpToolCall': return { title: item.server + '/' + item.tool, text: item.output, kind: 'execution' }
    case 'userInputRequest': return { title: '问题与回答', text: item.question + '\n' + (item.answer ?? ''), kind: 'messages' }
  }
}
/** Plain-text search in small slices keeps streaming/navigation responsive. No dynamic regex. */
export async function searchConversation(items: Item[], issues: OperationIssue[], query: string, scope: SearchScope, signal?: AbortSignal): Promise<{ hits: ConversationHit[]; truncated: boolean }> {
  const needle = query.trim().toLocaleLowerCase(), hits: ConversationHit[] = []
  if (!needle || needle.length > 300) return { hits, truncated: false }
  const errors = new Map(issues.map(issue => [issue.id, issue]))
  for (let index = 0; index < items.length; index++) {
    if (signal?.aborted) return { hits: [], truncated: false }
    if (index && index % 24 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    const item = items[index]!, entry = searchable(item), issue = errors.get(item.id)
    if (scope === 'issues' && !issue || scope !== 'all' && scope !== 'issues' && entry.kind !== scope) continue
    const text = scope === 'issues' ? issue!.reason + '\n' + issue!.output : entry.text
    const at = text.toLocaleLowerCase().indexOf(needle)
    if (at < 0) continue
    if (hits.length === 200) return { hits, truncated: true }
    const from = Math.max(0, at - 48), to = Math.min(text.length, at + needle.length + 96)
    hits.push({ id: item.id, title: entry.title, kind: scope === 'issues' ? 'issues' : entry.kind, snippet: (from ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : ''), start: at - from + (from ? 1 : 0), end: at - from + (from ? 1 : 0) + needle.length })
  }
  return { hits, truncated: false }
}
