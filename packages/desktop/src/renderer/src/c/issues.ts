import { sshSetupMarker } from '../../../shared/ssh-routing'
import type { Item } from '../bridge'
import { operationAssessments, type ExecutionAssessment } from '../../../../../kernel/src/protocol/assessment'

export type OperationIssue = { id: string; title: string; reason: string; hint: string; output: string; command?: string; blocked: boolean; kind: 'error' | 'finding' | 'unverified' }
const labels: Record<string, string> = { read: '读取文件', glob: '查找文件', grep: '搜索内容', web_search: '联网搜索', web_fetch: '读取网页', shell: '执行命令', write: '写入文件', apply_patch: '修改文件' }

/** Extract actual diagnostic lines; never turn successful stderr into a failure. */
export function operationIssues(items: Item[], allItems = items, assessments: Map<string, ExecutionAssessment> = operationAssessments(allItems)): OperationIssue[] {
  return items.flatMap(item => {
    const assessment = assessments.get(item.id)
    if (assessment?.recoveredBy) return []
    if (assessment?.kind === 'success' && item.status !== 'failed') return []
    if (!assessment && item.status !== 'failed' && item.status !== 'blocked' && !(item.kind === 'commandExecution' && item.status === 'completed' && item.exitCode !== null && item.exitCode !== 0)) return []
    const kind = assessment?.kind === 'finding' || assessment?.kind === 'unverified' ? assessment.kind : 'error'
    const output = item.kind === 'commandExecution' || item.kind === 'mcpToolCall' ? item.output : item.kind === 'fileChange' ? item.diff ?? '' : ''
    const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(line=>!!line&&!/^\[assessment:/i.test(line))
    let hint = '查看完整执行记录，核对命令、文件路径和运行环境后再处理。'
    let reason = ''
    if (item.kind === 'commandExecution' && (item.tool === 'web_search' || item.tool === 'web_fetch')) {
      reason = lines.find(line => !line.startsWith('[exit')) ?? '联网请求未完成'
      hint = '打开设置中的“联网搜索”，核对所选服务、API Key 和额度；取消、限速或超时后由你决定是否重试，不会自动换用另一付费服务。'
      return [{ id: item.id, title: labels[item.tool] + ' · ' + item.command, reason: reason.slice(0, 500), hint, output, command: item.command, blocked: item.status === 'blocked', kind }]
    }
    if(output.includes(sshSetupMarker)){reason='此对话尚未授权 SSH 执行目标';hint='点击“打开 SSH 连接”，在软件中填写用户名和密码，连接后绑定当前对话；不要求免密登录，也不自动重试原命令。'}
    else if(/credential\/config directories are off-limits|sensitive path/i.test(output)&&/\.ssh[\\/]/i.test(output+' '+(item.kind==='commandExecution'?item.command:''))){reason='SSH 凭据与配置目录受固定保护，不能由模型直接读取';hint='请使用软件 SSH 认证入口。普通权限或跳过审批不会开放凭据目录；密码和私钥不应粘贴到对话。'}
    else if(/Permission denied \((?:publickey|password|keyboard-interactive)/i.test(output)){reason=lines.find(line=>/Permission denied/i.test(line))??'SSH 认证未通过';hint='当前命令没有完成认证，主机信任记录不能证明在线或登录成功。使用软件 SSH 用户名/密码入口连接，再绑定此对话。'}
    else if (kind === 'unverified') { reason = assessment!.summary; hint = '单独执行相同范围的检查，保留真实退出码；跳过的项目不能算作通过。' }
    else if (kind === 'finding') { reason = lines.find(line => /TestingLibraryElementError|AssertionError|^FAILED\s|error TS\d+|(?:Error|Exception):/i.test(line)) ?? lines.find(line => /Would reformat|\b[1-9]\d* failed\b|Found \d+ errors?/i.test(line)) ?? assessment!.summary; hint = '检查已经执行，结果发现项目问题。只读检查会保留问题；修改任务需要处理后重新验证。' }
    else if (item.status === 'blocked') { reason = lines.find(line => !line.startsWith('[exit')) ?? '操作被当前权限或用户选择阻止'; hint = '如确实需要该操作，可调整权限后继续；不会自动重试被拒绝的操作。' }
    else if (lines.some(line => /not recognized|command not found|无法将.+识别|找不到命令/i.test(line))) { reason = lines.find(line => /not recognized|command not found|无法将.+识别|找不到命令/i.test(line))!; hint = '该命令在当前终端不可用。使用当前系统的终端语法，或改用文件读取和搜索工具。' }
    else if (lines.some(line => /SyntaxError:/.test(line))) { reason = lines.find(line => /SyntaxError:/.test(line))!; hint = '检查命令中的引号、转义和代码语法。' }
    else if (lines.some(line => /FileNotFoundError:|No such file or directory|cannot find the path|找不到指定的路径/i.test(line))) { reason = lines.findLast(line => /FileNotFoundError:|No such file or directory|cannot find the path|找不到指定的路径/i.test(line))!; hint = '核对当前工作目录、相对路径和文件是否存在。' }
    else if (output.includes('[timed out]')) { reason = '操作超过允许的运行时间，已停止'; hint = '检查命令是否等待输入，或缩小范围、调整超时后继续。' }
    else if (output.includes('[interrupted]') || /Cancelled before execution|^Interrupted$/.test(output)) { reason = '操作在完成前被中断'; hint = '先检查实际文件和进程状态，避免重复执行。' }
    else reason = lines.findLast(line => /^(?:E\s+)?[\w.]+(?:Error|Exception):|^FAILED\s|\berror[:\s]|失败|拒绝|denied/i.test(line)) ?? lines.find(line => !/^\[exit|^[.sF\s]+\[\s*\d+%\]|^=+$/.test(line)) ?? '操作未完成，未收到具体错误输出'
    if (item.kind === 'mcpToolCall') hint = '打开连接器与插件，检查来源、认证和连接诊断；核对远端操作状态后决定是否继续，避免重复执行。'
    const command = item.kind === 'commandExecution' ? item.command : item.kind === 'mcpToolCall' ? item.server + '/' + item.tool : undefined
    const title = item.kind === 'fileChange' ? '文件操作 · ' + item.path : item.kind === 'commandExecution' ? (labels[item.tool ?? 'shell'] ?? item.tool ?? '工具操作') + ' · ' + item.command : item.kind === 'mcpToolCall' ? '工具调用 · ' + command : '未完成的操作'
    return [{ id: item.id, title, reason: reason.slice(0, 500), hint, output, command, blocked: item.status === 'blocked', kind }]
  })
}

export function issueOverview(issues: OperationIssue[]) {
  const counts = { error: 0, finding: 0, unverified: 0 }
  const blocked = issues.filter(i => i.blocked).length
  for (const issue of issues) if (!issue.blocked) counts[issue.kind]++
  return [blocked && `${blocked} 项操作被阻止`, counts.error && `${counts.error} 项执行需处理`, counts.finding && `${counts.finding} 项检查发现`, counts.unverified && `${counts.unverified} 项待验证`].filter(Boolean).join(' · ')
}
