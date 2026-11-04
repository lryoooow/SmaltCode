import type { Session } from '../bridge'
import { artifacts } from './artifacts'
import { operationAssessments, type TurnAssessment } from '../../../../../kernel/src/protocol/assessment'
import { latestPlan } from './activity'
import { operationIssues } from './issues'

export function checkExplanation(item: Extract<Session['items'][number], { kind: 'commandExecution' }>, result: NonNullable<typeof item.assessment>) {
  const issue = operationIssues([item], [item], new Map([[item.id, { ...result, recoveredBy: undefined }]]))[0]
  const skipReasons = new Set<string>()
  for (const line of item.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    const reason = /^\s*SKIPPED\s+\[\d+\]\s+.+?:\d+:\s*(.+)$/i.exec(line)?.[1]
      ?? /^\s*ok\s+\d+\b.*?\s+#\s*SKIP\s+(.+)$/i.exec(line)?.[1]
    if (reason?.trim()) skipReasons.add(reason.trim().slice(0, 500))
    if (skipReasons.size >= 10) break
  }
  return { reason: issue?.reason, skipReasons: [...skipReasons] }
}

export function deliveryModel(session: Session, turnId: string, assessment: TurnAssessment) {
  const items = session.items.filter(item => item.turnId === turnId)
  const evidence = operationAssessments(session.items)
  const checks = items.flatMap(item => {
    const result = evidence.get(item.id)
    return item.kind === 'commandExecution' && result?.check ? [{ id: item.id, command: item.command, result, item }] : []
  })
  const files = artifacts(session, turnId)
  const plan = latestPlan(items, turnId)
  const pending = plan?.steps.filter(step => step.status !== 'completed') ?? []
  return {
    files, checks, pending, assessment, plan,
    show: !!(files.length || checks.length || plan || session.error || session.interrupted || assessment.verificationMissing),
    durationMs: session.summaries.findLast(summary => summary.turnId === turnId)?.durationMs,
  }
}
