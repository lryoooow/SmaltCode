import type { OfficeSession } from '../../../shared/office'
import { Btn } from './ui'

export default function OfficeSessionNotice({ session, error, busy, action }: { session?: OfficeSession; error?: string; busy: boolean; action: (name: string, value?: any, reset?: boolean) => Promise<any> }) {
  const reason = session?.reason || error
  if (!reason) return null
  const recoverable = session?.status === 'recoverable'
  return <div role="alert" data-testid="office-session-alert" className="shrink-0 border-b border-amber-500/25 bg-amber-500/5 px-4 py-3">
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex-1 min-w-48"><strong className="block text-[12px] text-amber-700 dark:text-amber-400">{recoverable ? '工作副本待恢复' : 'Office 工作副本需要处理'}</strong><p className="mt-1 max-h-24 overflow-auto break-words text-[12px] leading-6 text-[var(--text)]">{reason}</p></div>
      {session && <Btn disabled={busy} onClick={() => void action(recoverable ? 'office-recover' : session.closing ? 'office-close' : 'office-capture', {}, true)}>{recoverable ? '恢复落盘副本' : session.closing ? '重试结束编辑' : '重试收取候选'}</Btn>}
    </div>
  </div>
}
