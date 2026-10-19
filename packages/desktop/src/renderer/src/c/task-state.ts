import type { Session } from '../bridge'
import type { Status } from './ui'
import { assessTurn } from '../../../../../kernel/src/protocol/assessment'
export function sessionStatus(s: Session): Status {
  if (Object.keys(s.approvals).length) return 'approval'
  if (Object.keys(s.questions).length) return 'question'
  if (s.sending || (s.status && s.status.lifecycle !== 'idle')) return 'running'
  if (s.error) return 'failed'
  if (s.interrupted) return 'stopped'
  const lastTurn = s.items.at(-1)?.turnId
  const prompt = s.items.find(i => i.turnId === lastTurn && i.kind === 'userMessage')
  const assessment = s.summaries.findLast(summary => summary.turnId === lastTurn)?.assessment ?? (lastTurn ? assessTurn(s.items.filter(i => i.turnId === lastTurn), prompt?.kind === 'userMessage' ? prompt.text : '') : s.meta.lastAssessment)
  if (assessment?.status === 'findings') return 'findings'
  if (assessment?.status === 'unverified') return 'unverified'
  if (assessment?.status === 'needsAttention') return 'attention'
  return s.unread ? 'unread' : 'done'
}
export const statusLabels: Record<Status, string> = { running: '运行中', approval: '待审批', question: '待回答', failed: '失败', stopped: '已停止', unread: '未读结果', done: '已完成', findings: '检查发现问题', unverified: '部分验证未完成', attention: '仍有事项需处理' }
