import type { Session } from '../bridge'
import type { Status } from './ui'
export function sessionStatus(s: Session): Status {
  if (Object.keys(s.approvals).length) return 'approval'
  if (Object.keys(s.questions).length) return 'question'
  if (s.sending || (s.status && s.status.lifecycle !== 'idle')) return 'running'
  if (s.error) return 'failed'
  if (s.interrupted) return 'stopped'
  return s.unread ? 'unread' : 'done'
}
export const statusLabels: Record<Status, string> = { running: '运行中', approval: '待审批', question: '待回答', failed: '失败', stopped: '已停止', unread: '未读结果', done: '已完成' }
