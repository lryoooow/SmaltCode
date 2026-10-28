import type { Session } from '../bridge'
import { artifacts } from './artifacts'
import { operationAssessments, type TurnAssessment } from '../../../../../kernel/src/protocol/assessment'
import { latestPlan } from './activity'

export function deliveryModel(session: Session, turnId: string, assessment: TurnAssessment) {
  const items = session.items.filter(item => item.turnId === turnId)
  const evidence = operationAssessments(session.items)
  const checks = items.flatMap(item => {
    const result = evidence.get(item.id)
    return item.kind === 'commandExecution' && result?.check ? [{ id: item.id, command: item.command, result }] : []
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
