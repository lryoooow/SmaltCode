import type { Item, ThreadStatus } from '../bridge'

export type TimelineEntry =
  | { kind: 'message'; item: Item }
  | { kind: 'activity'; id: string; turnId: string; items: Item[] }

/** Fold adjacent work from one turn; user and assistant messages retain their order. */
export function activityTimeline(items: Item[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const item of items) {
    if (item.kind === 'agentMessage' && !item.text.trim()) continue
    if (item.kind === 'userMessage' || item.kind === 'agentMessage' || item.kind === 'userInputRequest') {
      entries.push({ kind: 'message', item })
      continue
    }
    const previous = entries.at(-1)
    if (previous?.kind === 'activity' && previous.turnId === item.turnId) previous.items.push(item)
    else entries.push({ kind: 'activity', id: item.id, turnId: item.turnId, items: [item] })
  }
  return entries
}

type ProgressOptions = { running?: boolean; lifecycle?: ThreadStatus['lifecycle']; interrupted?: boolean }
const STAGES: Record<string, string> = {
  read: '正在读取资料', grep: '正在搜索内容', glob: '正在查找文件',
  write: '正在生成文件', apply_patch: '正在更新文件', shell: '正在执行操作',
  plan: '正在安排步骤', ask_user: '等待你的回答',
}
function unsuccessful(item: Item) {
  return item.status === 'failed' || item.status === 'blocked' ||
    (item.kind === 'commandExecution' && item.status === 'completed' && item.exitCode !== null && item.exitCode !== 0)
}

/** Checkpoints come only from successful completions, never simulated progress. */
export function activityProgress(items: Item[], options: ProgressOptions = {}) {
  let reads = 0, searches = 0, commands = 0, others = 0, plans = 0
  const files = new Set<string>()
  const issues = items.filter(unsuccessful)
  const blocked = issues.filter(item => item.status === 'blocked').length
  for (const item of items) {
    if (item.status !== 'completed' || unsuccessful(item)) continue
    if (item.kind === 'fileChange') files.add(item.path)
    else if (item.kind === 'plan') plans++
    else if (item.kind === 'mcpToolCall') others++
    else if (item.kind === 'commandExecution') {
      if (item.tool === 'read') reads++
      else if (item.tool === 'grep' || item.tool === 'glob') searches++
      else if (item.tool === 'shell' || !item.tool) commands++
      else if (item.tool !== 'ask_user') others++
    }
  }
  const milestones = [
    reads && `已读取 ${reads} 项资料`, searches && `已完成 ${searches} 次查找`,
    commands && `已执行 ${commands} 项操作`, files.size && `已更新 ${files.size} 个文件`,
    others && `已完成 ${others} 项工具操作`,
  ].filter(Boolean) as string[]
  if (!milestones.length && plans) milestones.push('执行计划已更新')
  const warnings = [blocked && `${blocked} 项操作被阻止`, issues.length > blocked && `${issues.length - blocked} 项操作${options.interrupted ? '未完成' : '失败'}`].filter(Boolean).join('，')
  let label = options.interrupted ? '已停止' : issues.length ? '部分操作未完成' : '过程已结束'
  if (options.running) {
    const lifecycle = options.lifecycle
    if (lifecycle === 'waitingForPermission') label = '等待你确认操作'
    else if (lifecycle === 'waitingForUser') label = '等待你的回答'
    else if (lifecycle === 'compacting') label = '正在整理上下文'
    else if (lifecycle === 'retrying') label = '请求失败，正在重试'
    else if (lifecycle === 'cancelling') label = '正在停止'
    else if (lifecycle === 'preparing') label = '正在准备任务'
    else {
      const active = items.findLast(item => item.status === 'inProgress')
      label = active?.kind === 'agentMessage' ? '正在组织回复'
        : active?.kind === 'reasoning' ? '正在思考'
        : active?.kind === 'commandExecution' ? STAGES[active.tool ?? 'shell'] ?? '正在使用工具'
        : active?.kind === 'fileChange' ? '正在更新文件'
        : active?.kind === 'plan' ? '正在安排步骤'
        : active?.kind === 'mcpToolCall' ? '正在使用工具'
        : items.length ? '正在整理下一步' : '正在思考'
    }
  }
  return { label, milestones, warnings, issueCount: issues.length, count: items.filter(i => i.kind !== 'userMessage' && i.kind !== 'agentMessage' && i.kind !== 'userInputRequest').length }
}
