import { describe, expect, it } from 'vitest'
import { emptyInspector, inspectorGeometry } from '../src/renderer/src/c/inspector-layout'
import { deliveryModel } from '../src/renderer/src/c/delivery-state'
import { activityProgress } from '../src/renderer/src/c/activity'
import { assessTurn } from '../../kernel/src/protocol/assessment'
import type { Session, Item } from '../src/renderer/src/bridge'

const base = { threadId: 'thread', turnId: 'current', createdAt: '2026-10-22T00:00:00Z', status: 'completed' as const }
const change = (id: string, turnId = 'current'): Item => ({ ...base, id, turnId, kind: 'fileChange', path: 'D:/project/' + id + '.md', changeKind: 'add' })
function session(items: Item[]): Session { return { meta: { id: 'thread', title: '任务', cwd: 'D:/project', model: 'fixture', createdAt: base.createdAt, updatedAt: base.createdAt, turnCount: 1 }, items, summaries: [], approvals: {}, questions: {} } }
describe('workspace presentation contracts', () => {
  it('shows checkpoint text in the single progress surface without claiming model statements are verified work', () => {
    const checkpoint:Item={...base,id:'checkpoint',kind:'commandExecution',tool:'task_checkpoint',command:'task_checkpoint',output:JSON.stringify({managedCheckpoint:true,status:'continue',summary:'已整理待核对来源，接下来检查文档。'}),exitCode:0};
    const result=activityProgress([checkpoint],{running:true,lifecycle:'running'});
    expect(result.recent).toContain('任务节点（模型说明）');expect(result.recent).toContain('接下来检查文档');expect(result.milestones).toEqual([]);
  })
  it('keeps navigation-independent reading space and uses focus instead of squeezing a preview', () => {
    for (const available of [886, 1000, 1300, 1684]) {
      const geometry = inspectorGeometry(available, 900)
      expect(geometry.focus).toBe(false); expect(geometry.width).toBeGreaterThanOrEqual(360)
      expect(available - geometry.width - 6).toBeGreaterThanOrEqual(520)
    }
    expect(inspectorGeometry(664, 480)).toMatchObject({ focus: true, width: 664 })
    expect(inspectorGeometry(1300, 480, true)).toMatchObject({ focus: true, width: 1300 })
    expect(emptyInspector(Number.NaN)).toMatchObject({ open: false, width: 480 })
  })
  it('does not invent a delivery for ordinary chat or treat a generic successful command as verification', () => {
    const chat: Item = { ...base, id: 'a', kind: 'agentMessage', text: '你好' }
    expect(deliveryModel(session([chat]), 'current', assessTurn([chat], '你好')).show).toBe(false)
    const command: Item = { ...base, id: 'c', kind: 'commandExecution', command: 'node script.cjs', output: 'ok', exitCode: 0 }
    expect(deliveryModel(session([command]), 'current', assessTurn([command], '检查')).checks).toEqual([])
  })
  it('limits files to this turn and excludes rolled-back changes while retaining pending plans and check findings', () => {
    const items: Item[] = [change('old', 'old-turn'), change('new'), change('rolled-back'), { ...base, id: 'plan', kind: 'plan', steps: [{ content: '生成报告', status: 'completed' }, { content: '核对数据', status: 'pending' }] }, { ...base, id: 'test', kind: 'commandExecution', command: 'npm test', output: '1 failed', exitCode: 1 }]
    const s = session(items); s.meta.restoredChanges = { 'rolled-back': ['rolled-back.md'] }
    const result = deliveryModel(s, 'current', assessTurn(items.filter(item => item.turnId === 'current'), '修复'))
    expect(result.files.map(file => file.name)).toEqual(['new.md'])
    expect(result.pending.map(step => step.content)).toEqual(['核对数据'])
    expect(result.checks[0].result).toMatchObject({ check: 'test', kind: 'finding' })
  })
  it('keeps a completed plan result addressable without pretending that a test or file was produced', () => {
    const items: Item[] = [{ ...base, id: 'plan', kind: 'plan', steps: [{ content: '核对说明', status: 'completed' }] }]
    const result = deliveryModel(session(items), 'current', assessTurn(items, '核对说明'))
    expect(result.show).toBe(true); expect(result.files).toEqual([]); expect(result.checks).toEqual([])
    expect(result.pending).toEqual([]); expect(result.plan?.steps[0].content).toBe('核对说明')
  })
})
