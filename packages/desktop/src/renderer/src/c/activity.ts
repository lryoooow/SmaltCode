import type { Item, ThreadStatus } from '../bridge'
import { executionAssessment, operationAssessments, type ExecutionAssessment } from '../../../../../kernel/src/protocol/assessment'
import { operationIssues, issueOverview } from './issues'

export type TimelineEntry =
  | { kind: 'message'; item: Item }
  | { kind: 'plan'; item: Extract<Item, { kind: 'plan' }> }
  | { kind: 'activity'; id: string; turnId: string; items: Item[] }

/** Fold adjacent work from one turn; user and assistant messages retain their order. */
export function activityTimeline(items: Item[], dockedTurnId?: string): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const plans = new Map<string, Item>()
  for (const item of items) if (item.kind === 'plan') plans.set(item.turnId, item)
  for (const item of items) {
    if (item.kind === 'plan') {
      if (item.turnId !== dockedTurnId && plans.get(item.turnId) === item && item.steps.length) entries.push({ kind: 'plan', item })
      continue
    }
    if (item.kind === 'commandExecution' && item.tool === 'plan') continue
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

type ProgressOptions = { running?: boolean; lifecycle?: ThreadStatus['lifecycle']; interrupted?: boolean; cwd?: string }
const STAGES: Record<string, string> = {
  read: '正在读取资料', grep: '正在搜索内容', glob: '正在查找文件',
  ssh_exec:'正在执行远程命令',ssh_read:'正在读取远程项目',ssh_write:'正在保存远程文件',ssh_process_read:'正在核对远程运行',ssh_process_stop:'正在清理远程运行',
  write: '正在生成文件', apply_patch: '正在更新文件', shell: '正在执行命令',
  plan: '正在安排步骤', ask_user: '等待你的回答',
  task_checkpoint: '正在记录任务节点',
}

function briefPath(value: string, cwd?: string): string {
  const path = value.replace(/\\/g, '/')
  const root = cwd?.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return (cwd && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path).slice(0, 180)
}
function operationDetail(item: Item, cwd?: string): string | undefined {
  if (item.kind === 'fileChange') return briefPath(item.path, cwd)
  if (item.kind === 'mcpToolCall') return `${item.server} · ${item.tool}`
  if (item.kind !== 'commandExecution') return undefined
  if (item.tool === 'task_checkpoint') { try { const value=JSON.parse(item.output);if(value.managedCheckpoint===true&&typeof value.summary==='string')return value.summary.slice(0,180) } catch { /* An unfinished/old checkpoint has no structured summary. */ } return undefined }
  if (item.tool === 'read' || item.tool === 'write') return briefPath(item.command.replace(/^\S+\s*/, ''), cwd)
  if (item.tool === 'glob' || item.tool === 'grep') return item.tool === 'glob' ? '查找工作文件夹中的匹配文件' : '检索工作文件夹中的相关内容'
  if (item.tool === 'shell' || !item.tool) {
    // Expose the program/script being run, not inline source code or command payloads.
    const words = item.command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map(w => w.replace(/^(["'])([\s\S]*)\1$/, '$2')) ?? []
    const script = words.find(w => /\.(?:cjs|mjs|js|py|ps1|cmd|bat|sh)$/i.test(w))
    if (script && !words.some(w => w === '-e' || w === '-c')) return briefPath(script, cwd)
    const program = /\b(pnpm|npm|yarn|uv|cargo|dotnet|ruff|pytest|vitest|jest|tsc|git|node|python|powershell|pwsh)(?:\.(?:exe|cmd))?\b/i.exec(item.command)?.[1]
    return program === 'node' ? 'Node.js 程序' : program
  }
  return undefined
}

export function latestPlan(items: Item[], turnId?: string) {
  const plan = items.findLast((item): item is Extract<Item, { kind: 'plan' }> => item.kind === 'plan' && item.turnId === turnId)
  return plan?.steps.length ? plan : undefined
}

export function planProgress(plan: Extract<Item, { kind: 'plan' }>) {
  const done = plan.steps.filter(s => s.status === 'completed').length
  const activeIndex = plan.steps.findIndex(s => s.status === 'inProgress')
  const nextIndex = plan.steps.findIndex(s => s.status === 'pending')
  const index = activeIndex >= 0 ? activeIndex : nextIndex
  return { done, total: plan.steps.length, index, current: index >= 0 ? plan.steps[index] : undefined, complete: done === plan.steps.length }
}
function unsuccessful(item: Item) {
  return item.status === 'failed' || item.status === 'blocked' ||
    (item.kind === 'commandExecution' && item.status === 'completed' && item.exitCode !== null && item.exitCode !== 0)
}

/** Checkpoints come only from successful completions, never simulated progress. */
export function activityProgress(items: Item[], options: ProgressOptions = {}, allItems = items, assessments: Map<string, ExecutionAssessment> = operationAssessments(allItems)) {
  let reads = 0, searches = 0, commands = 0, others = 0
  const files = new Set<string>()
  const issues = operationIssues(items, allItems, assessments)
  for (const item of items) {
    const a = assessments.get(item.id)
    if (item.status !== 'completed' || (a ? a.kind !== 'success' : unsuccessful(item))) continue
    if (item.kind === 'fileChange') files.add(item.path)
    else if (item.kind === 'mcpToolCall') others++
    else if (item.kind === 'commandExecution') {
      if (item.tool === 'read') reads++
      else if (item.tool === 'grep' || item.tool === 'glob') searches++
      else if (item.tool === 'shell' || !item.tool) commands++
      else if (item.tool !== 'ask_user' && item.tool !== 'plan' && item.tool !== 'task_checkpoint') others++
    }
  }
  const milestones = [
    reads && `已读取 ${reads} 项资料`, searches && `已完成 ${searches} 次查找`,
    commands && `已执行 ${commands} 项操作`, files.size && `已更新 ${files.size} 个文件`,
    others && `已完成 ${others} 项工具操作`,
  ].filter(Boolean) as string[]
  const recovered = items.filter(i => assessments.get(i.id)?.recoveredBy).length
  const warnings = [issueOverview(issues), recovered && `${recovered} 项已重试或改用可用工具`].filter(Boolean).join(' · ')
  let label = options.interrupted ? '已停止' : issues.length ? '有结果需查看' : '过程已结束'
  let detail: string | undefined
  const previous = items.findLast(item => item.status === 'completed' && (item.kind === 'fileChange' || item.kind === 'mcpToolCall' || item.kind === 'commandExecution' && item.tool !== 'plan' && item.tool !== 'ask_user') && (assessments.get(item.id)?.kind === 'success' || !assessments.has(item.id) && !unsuccessful(item)))
  const recentDetail = previous ? operationDetail(previous, options.cwd) : undefined
  const recent = previous?.kind === 'commandExecution' && previous.tool === 'task_checkpoint' ? `任务节点（模型说明）${recentDetail ? ' · ' + recentDetail : ''}` : previous?.kind === 'fileChange' ? `已更新 ${recentDetail}` : previous?.kind === 'commandExecution' && previous.tool === 'read' ? `已读取 ${recentDetail}` : previous?.kind === 'commandExecution' && (previous.tool === 'grep' || previous.tool === 'glob') ? '已完成一次资料查找' : previous ? `已完成${recentDetail ? ' · ' + recentDetail : '一项操作'}` : undefined
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
        : active?.kind === 'reasoning' ? '正在分析下一步'
        : active?.kind === 'commandExecution' ? STAGES[active.tool ?? 'shell'] ?? '正在使用工具'
        : active?.kind === 'fileChange' ? '正在更新文件'
        : active?.kind === 'plan' ? '正在安排步骤'
        : active?.kind === 'mcpToolCall' ? '正在使用工具'
        : '等待模型响应'
      if (active) detail = operationDetail(active, options.cwd)
      if (active?.kind === 'commandExecution' && (active.tool === 'shell' || !active.tool)) {
        const check = executionAssessment(active.command, '', null).check
        if (check) label = { format: '正在检查格式', test: '正在运行测试', lint: '正在检查代码', typecheck: '正在检查类型', build: '正在构建项目' }[check]
      }
    }
  }
  return { label, detail, recent, milestones, warnings, issueCount: issues.length, count: items.filter(i => i.kind !== 'userMessage' && i.kind !== 'agentMessage' && i.kind !== 'userInputRequest' && i.kind !== 'plan' && !(i.kind === 'commandExecution' && i.tool === 'plan')).length }
}
