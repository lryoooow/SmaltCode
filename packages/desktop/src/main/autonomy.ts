import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Kernel, ToolDefinition, RunPolicy } from '@smalt/kernel';
import type { TurnOutcome } from '../../../kernel/src/core/turn-runner.js';
import type { ContextReference } from './context-files.js';
import { AutonomyStore } from './autonomy-store.js';
import { IntegrationVault } from './integration-vault.js';
import { autonomyDigest, boundText, canonical, commonTask, goalConfig, budgetConfig, localPath, memoryConfig, nextSlot, slotKey, timingConfig, scopeConfig } from './autonomy-policy.js';
import type { AutonomyData, AutonomyState, Evidence, Goal, GoalConfig, ManagedRun, Memory, MemoryConfig, Schedule, ScheduleConfig, Scope, TaskTemplate } from '../shared/autonomy.js';

type Options = { externalSlots?: () => number; directory: string; kernel: Kernel; scope(value: Scope, interactive: boolean): Promise<void>; modelFingerprint(model: string): string; read(cwd: string, path: string): Promise<{ text: string; digest?: string }>; context(cwd: string, refs: ContextReference[]): Promise<{ text: string; references: Array<{ path: string; label: string }>; images?: any[] }>; consent(title: string, detail: string): Promise<boolean>; cleanup(threadId: string): Promise<void>; idle?(threadId:string):void; notify(): void; online(): boolean; now?: () => number; startTimer?: boolean };
type Active = { owner: string; runId: string; threadId: string; controller: AbortController; started: number; stoppedAt?: number; done?: Promise<void>; report?: { status: 'continue' | 'review' | 'blocked'; summary: string } };
const id = (prefix: string) => prefix + '_' + randomUUID();
const stamp = (time = Date.now()) => new Date(time).toISOString();
const zero = () => ({ turns: 0, requests: 0, tools: 0, tokens: 0, milliseconds: 0 });
const runConfig = (s: Schedule): ScheduleConfig => ({ cwd: s.cwd, canonical: s.canonical, projectId: s.projectId, title: s.title, instructions: s.instructions, model: s.model, timing: s.timing, budget: s.budget, maxRuns: s.maxRuns, endsAt: s.endsAt, references: s.references, memoryIds: s.memoryIds });

/** A local, finite, opt-in scheduler. Nothing here is driven by renderer mounting or model instructions. */
export class Autonomy {
  readonly store: AutonomyStore; readonly vault: IntegrationVault;
  private active = new Map<string, Active>(); private launches = new Set<string>(); private revision = 0;
  private timer?: ReturnType<typeof setInterval>; private notification?: ReturnType<typeof setTimeout>; private stopped = false; private closing = false; private suspended = false; private ticking = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: Options) {
    this.store = new AutonomyStore(options.directory); this.vault = new IntegrationVault(join(options.directory, 'autonomy-approvals.json'), 160);
    if (!this.store.notice) {
      const data = structuredClone(this.store.data); let changed = false;
      for (const goal of data.goals) if (goal.status === 'running') { goal.status = 'paused'; goal.reason = '上次运行未正常结束，请核对文件和远端状态后手动继续'; changed = true; }
      for (const run of data.runs) if (run.status === 'running') { run.status = 'interrupted'; run.endedAt = this.at(); run.reason = '应用退出或中断；没有重放此轮操作'; changed = true; }
      if (changed) { try { this.store.save(data); } catch { /* Preserve source bytes; ordinary chat must still start. */ } }
    }
    this.options.kernel.tools.register(this.checkpointTool());
    if (!this.store.notice && !this.vault.notice) { try { this.skipMissed('应用未运行时错过时段，已跳过且不重放'); } catch (error) { this.fatal(error); } }
    if (options.startTimer !== false) { this.timer = setInterval(() => { void this.tick().catch(error => this.fatal(error)); }, 1000); this.timer.unref(); }
  }
  occupied() { return new Set([...this.active.keys(), ...this.launches]).size; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private at() { return stamp(this.now()); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.catch(() => {}); return result; }
  private writable(internal = false) { if (this.stopped || this.closing && !internal || this.store.notice || this.vault.notice) throw new Error(this.store.notice ?? this.vault.notice ?? '软件正在退出'); }
  private save(fn: (data: AutonomyData) => void) { this.writable(true); const data = structuredClone(this.store.data); fn(data); const running = new Set(data.runs.filter(run => run.status === 'running').map(run => run.id)), recent = new Set(data.runs.filter(run => !running.has(run.id)).slice(-Math.max(0,240-running.size)).map(run => run.id)); data.runs = data.runs.filter(run => running.has(run.id) || recent.has(run.id)); data.uses = data.uses.slice(-1000); try { this.store.save(data); } catch (error) { if (this.store.notice) this.fatal(error); throw error; } this.changed(); }
  private fatal(error: unknown) { this.suspended = true; this.launches.clear(); for (const entry of this.active.values()) { entry.stoppedAt = this.now(); entry.controller.abort(); } this.store.notice ??= '持续任务已暂停：' + this.message(error) + '。普通对话仍可使用。'; this.changed(); }
  private changed() { this.revision++; if (!this.notification) this.notification = setTimeout(() => { this.notification = undefined; this.options.notify(); }, 60); }
  private goal(id: string) { const value = this.store.data.goals.find(entry => entry.id === id); if (!value) throw new Error('持续任务不存在'); return value; }
  private schedule(id: string) { const value = this.store.data.schedules.find(entry => entry.id === id); if (!value) throw new Error('定时任务不存在'); return value; }
  private binding(value: Schedule | Memory) { return autonomyDigest('timing' in value ? { config: runConfig(value), modelEndpoint: this.options.modelFingerprint(value.model), memories: value.memoryIds.map(id => ({ id, digest: this.store.data.memories.find(memory => memory.id === id)?.digest })) } : memoryConfig(value)); }
  private approved(value: Schedule | Memory) { try { return this.vault.get(value.id, this.binding(value)).approved === true; } catch { return false; } }
  private ensureRevision(value: { revision: number }, revision: unknown) { if (revision !== value.revision) throw new Error('内容已变化，请刷新后再操作'); }
  private recheck(collection:'schedules'|'memories'|'templates',valueId?:string,revision?:number){if(!valueId)return;const value=this.store.data[collection].find(value=>value.id===valueId);if(!value)throw new Error('内容已移除，请刷新后再操作');this.ensureRevision(value,revision);}
  list(): AutonomyState { const data = structuredClone(this.store.data); return { ...data, revision: this.revision, suspended: this.suspended, notice: this.store.notice ?? (this.vault.notice ? '持续任务授权记录损坏或无法解密，已停止自动执行。原 autonomy-approvals.json 保留，请恢复备份后重启。' : undefined), secretStorage: this.vault.storage, authorized: Object.fromEntries([...data.schedules, ...data.memories].map(value => [value.id, this.approved(value)])) }; }
  assertMutation(threadId: string, method: string, patch: any) {
    const active = [...this.active.values()].find(entry => entry.threadId === threadId), goal = this.store.data.goals.find(goal => goal.threadId === threadId && (goal.status === 'running' || this.launches.has(goal.id)));
    if ((active || goal) && ['thread/archive','thread/delete','thread/project/update'].includes(method)) throw new Error('请先暂停或停止所属托管任务，再移动、归档或删除对话');
    if ((active || goal) && ['turn/start','turn/steer','thread/compact/start'].includes(method)) throw new Error('此对话属于正在运行的托管任务，请先暂停再发送消息或整理上下文');
    if (active && this.store.data.runs.find(run => run.id === active.runId)?.kind === 'schedule' && method === 'thread/settings/update') throw new Error('定时运行使用固定只读权限和模型；请停用后修改任务配置');
    if (goal && method === 'thread/settings/update' && patch?.model) throw new Error('请先暂停持续任务后再修改模型');
  }
  assertProjectMutation(projectId: string) { if (this.store.data.goals.some(g => g.projectId === projectId && (g.status === 'running' || this.launches.has(g.id) || this.active.has(g.id))) || this.store.data.schedules.some(s => s.projectId === projectId && (s.enabled || this.launches.has(s.id) || this.active.has(s.id)))) throw new Error('请先暂停项目的持续任务并停用定时任务，再修改或删除项目'); }
  stopForThread(threadId: string) { const entry = [...this.active.values()].find(entry => entry.threadId === threadId); if (entry) { entry.stoppedAt = this.now(); entry.controller.abort(); const goal = this.store.data.goals.find(goal => goal.id === entry.owner); if (goal) this.save(data => { const g = data.goals.find(g => g.id === goal.id)!; g.status = 'paused'; g.reason = '用户从对话停止了持续任务'; }); } }
  async saveGoal(raw: unknown, goalId?: string, revision?: number) {
    return this.serial(async () => { this.writable(); const config = goalConfig(raw); await this.options.scope(config, true); this.options.modelFingerprint(config.model);
      const old = goalId ? this.goal(goalId) : undefined; if (old) { this.ensureRevision(old, revision); if (this.active.has(old.id) || this.launches.has(old.id) || old.status === 'running') throw new Error('请先暂停任务再编辑'); }
      const value: Goal = { ...config, id: old?.id ?? id('goal'), revision: (old?.revision ?? 0) + 1, status: 'draft', reason: old ? '配置已更新，下次开始使用新预算；旧运行证据保留' : undefined, createdAt: old?.createdAt ?? this.at(), updatedAt: this.at(), spent: zero(), repeats: 0 };
      this.save(data => { data.goals = [...data.goals.filter(g => g.id !== value.id), value]; }); return value;
    });
  }
  async startGoal(goalId: string) {
    this.writable(); const value = this.goal(goalId); if (this.launches.has(goalId) || this.active.has(goalId) || value.status === 'running') throw new Error('任务已在运行');
    if (['completed','stopped','budget'].includes(value.status)) throw new Error('请编辑并重新保存任务后开始新预算');
    if (this.occupied() + (this.options.externalSlots?.() ?? 0) >= 2) throw new Error('最多同时运行两个托管任务');
    this.launches.add(goalId);
    try {
      const config = goalConfig(value); await this.options.scope(config, true); const endpoint = this.options.modelFingerprint(config.model);
      if (!await this.options.consent('开始持续任务', `${value.title}\n工作区：${value.cwd}\n模型：${value.model}\n权限：${value.mode}\n完成条件：${value.completion.kind === 'review' ? '用户验收，模型只能申请验收' : value.completion.path + ' 包含指定文字'}\n预算：${value.budget.turns} 轮 / ${value.budget.requests} 次请求 / ${value.budget.tools} 项操作 / ${value.budget.tokens} Token / ${value.budget.minutes} 分钟。\n\n预算消耗累计保留；暂停后不自动续跑。运行不启动后台进程，项目和用户 Hooks 不执行。`)) throw new Error('已取消开始');
      if (this.stopped || this.suspended || !this.launches.has(goalId)) throw new Error('开始已取消');
      const current = this.goal(goalId); if (current.revision !== value.revision || current.status !== value.status) throw new Error('任务已变化');
      await this.options.scope(current, false); if (this.options.modelFingerprint(current.model) !== endpoint) throw new Error('模型端点已变化，请重新开始并核对');
      if (!this.launches.has(goalId) || this.suspended) throw new Error('开始已取消');
      if (this.occupied() + (this.options.externalSlots?.() ?? 0) > 2) throw new Error('最多同时运行两个托管任务');
      if (this.budgetEnded(current)) throw new Error('剩余预算不足，请编辑预算后重新开始');
      let threadId = current.threadId;
      if (!threadId) { const rt = this.options.kernel.threads.start({ cwd: current.cwd, model: current.model, title: current.title, permissionMode: current.mode, projectId: current.projectId }); threadId = rt.meta.id; }
      const meta = this.options.kernel.threads.read(threadId).meta; if (meta.archived || canonical(meta.cwd) !== current.canonical || meta.projectId !== current.projectId || (meta.provider ? meta.provider + '/' : '') + meta.model !== current.model) throw new Error('所属对话设置已变化，请编辑并保存为新的持续任务');
      this.options.idle?.(threadId);
      if (meta.permissionMode !== current.mode) this.options.kernel.threads.update(threadId, { permissionMode: current.mode });
      this.save(data => { const g = data.goals.find(g => g.id === goalId)!; Object.assign(g, { threadId, status: 'running', reason: undefined, updatedAt: this.at() }); });
      const active: Active = { owner: goalId, runId: '', threadId, controller: new AbortController(), started: this.now() }; this.active.set(goalId, active);
      active.done = this.goalLoop(goalId, active).catch(error => { this.failGoal(goalId, error); }).finally(async () => { try { await this.options.cleanup(active.threadId); } catch (error) { try { this.finishGoal(goalId, 'blocked', '进程清理未完成：' + this.message(error)); } catch (failure) { this.fatal(failure); } } this.active.delete(goalId); this.changed(); }); return { threadId };
    } finally { this.launches.delete(goalId); }
  }
  private budgetEnded(goal: Goal) { return goal.spent.turns >= goal.budget.turns || goal.spent.requests >= goal.budget.requests || goal.spent.tools >= goal.budget.tools || goal.spent.tokens >= goal.budget.tokens || goal.spent.milliseconds >= goal.budget.minutes * 60000; }
  private failGoal(goalId: string, error: unknown) { if (this.store.notice) return; try { this.save(data => { const goal = data.goals.find(g => g.id === goalId); if (goal?.status === 'running') { goal.status = 'blocked'; goal.reason = error instanceof Error ? error.message : String(error); } }); } catch { /* Storage failures are surfaced in the manager notice. */ } }
  private async goalLoop(goalId: string, active: Active) {
    while (!active.controller.signal.aborted) {
      const goal = this.goal(goalId); if (goal.status !== 'running') break;
      await this.options.scope(goal, false); if (!this.options.online()) { this.failGoal(goalId, new Error('网络离线，已暂停；联网后需手动继续，不重放操作')); break; }
      if (this.budgetEnded(goal)) { this.finishGoal(goalId, 'budget', '已达到设定预算，等待用户检查'); break; }
      if (await this.goalEvidence(goal)) { this.finishGoal(goalId, 'completed', '本机验收文件已匹配所设条件'); break; }
      const elapsed = Math.max(0, this.now() - active.started);
      if (goal.spent.milliseconds + elapsed >= goal.budget.minutes * 60000) { this.save(data => { data.goals.find(g => g.id === goalId)!.spent.milliseconds += elapsed; }); this.finishGoal(goalId, 'budget', '已达到设定的运行时间，未发送新的模型请求'); break; }
      const run = this.claim(goalId, 'goal', id('round'), active.threadId); active.runId = run.id; active.report = undefined;
      const limits: RunPolicy = { maxRequests: goal.budget.requests - goal.spent.requests, maxTools: goal.budget.tools - goal.spent.tools, maxTokens: goal.budget.tokens - goal.spent.tokens, deadlineAt: Date.now() + Math.max(1, goal.budget.minutes * 60000 - goal.spent.milliseconds), signal: active.controller.signal };
      let outcome: TurnOutcome;
      try {
        const prepared = await this.prepareMessage(active.threadId, this.goalPrompt(goal), [], 'managed', run.id);
        limits.deadlineAt = Date.now() + goal.budget.minutes * 60000 - goal.spent.milliseconds - Math.max(0, this.now() - active.started);
        outcome = await this.options.kernel.threads.runManaged(active.threadId, { text: prepared.input, displayText: goal.spent.turns ? '继续持续目标：' + goal.title : goal.instructions, references: prepared.references }, limits);
      } catch (error) { this.endRun(run.id, 'failed', { reason: this.message(error) }); throw error; }
      const spent = Math.max(0, (active.stoppedAt ?? this.now()) - active.started), fingerprint = autonomyDigest({ text: outcome.assistantText, files: this.options.kernel.threads.read(active.threadId).items.filter(item => item.turnId === outcome.turnId && item.kind !== 'userMessage').map(item => item.kind === 'commandExecution' || item.kind === 'mcpToolCall' ? [item.kind, item.status, item.output] : item.kind === 'fileChange' ? [item.path,item.diff] : item.kind === 'agentMessage' ? item.text : item.kind === 'plan' ? item.steps : item.kind) });
      this.save(data => { const g = data.goals.find(g => g.id === goalId)!; g.spent.turns++; g.spent.requests += outcome.metrics?.requests ?? 0; g.spent.tools += outcome.metrics?.toolCalls ?? outcome.summary?.toolCount ?? 0; g.spent.tokens += outcome.metrics?.chargedTokens ?? outcome.usage.inputTokens + outcome.usage.outputTokens; g.spent.milliseconds += spent; g.repeats = g.lastFingerprint === fingerprint ? g.repeats + 1 : 0; g.lastFingerprint = fingerprint; g.updatedAt = this.at(); });
      const evidence = await this.goalEvidence(this.goal(goalId));
      this.endRun(run.id, outcome.failed ? 'failed' : outcome.stopReason ? 'budget' : outcome.interrupted ? 'interrupted' : 'completed', { turnId: outcome.turnId, summary: outcome.assistantText.slice(-3000), reason: outcome.error ?? this.stopLabel(outcome.stopReason), evidence: evidence ? [evidence] : [], metrics: outcome.metrics, usage: outcome.usage });
      active.started = this.now();
      const current = this.goal(goalId), report = this.report(active);
      if (current.status !== 'running' || active.controller.signal.aborted) break;
      if (evidence) { this.finishGoal(goalId, 'completed', '本机验收文件已匹配所设条件'); break; }
      if (outcome.stopReason === 'context') { this.finishGoal(goalId, 'blocked', outcome.error ?? '上下文需要检查，请暂停后手动整理或减少引用'); break; }
      if (outcome.stopReason || this.budgetEnded(current)) { this.finishGoal(goalId, 'budget', outcome.error ?? '已达到设定的累计预算，请检查结果后重新配置'); break; }
      if (outcome.failed || report?.status === 'blocked' || current.stopOnIssue && ['needsAttention','findings','unverified'].includes(outcome.summary?.assessment?.status ?? '')) { this.finishGoal(goalId, 'blocked', this.resultReason(active.threadId,outcome) ?? report?.summary ?? '本轮仍有未完成检查，请打开对话核对后继续'); break; }
      if (outcome.interrupted) { this.finishGoal(goalId, 'paused', '本轮已中断，不自动重放；请检查实际状态'); break; }
      if (report?.status === 'review' || current.completion.kind === 'review' && report?.status !== 'continue') { this.finishGoal(goalId, 'review', report?.summary ?? '本轮已结束，等待用户验收；模型回复不等于验收通过'); break; }
      if (current.repeats >= 1) { this.finishGoal(goalId, 'blocked', '连续两轮没有可区分的进展，已停止自动继续'); break; }
      await new Promise<void>(resolve => setTimeout(resolve, 150));
    }
    if (this.goal(goalId).status === 'running') this.finishGoal(goalId, 'paused', '已暂停，等待用户继续');
  }
  private report(active: Active) { return active.report; }
  private goalPrompt(goal: Goal) { return `${goal.instructions}\n\n持续目标：${goal.title}\n完成条件：${goal.completion.kind === 'review' ? '完成后申请用户验收，不能自行宣布用户已验收。' : JSON.stringify(goal.completion)}\n本任务有用户设定的有限预算。每个关键节点可用 task_checkpoint 记录 continue/review/blocked 和依据。遇到缺少信息、权限或失败应明确说明，不重复失败操作，不启动后台进程。以上约定不改变工作区和操作权限。`; }
  private async goalEvidence(goal: Goal): Promise<Evidence | undefined> { if (goal.completion.kind !== 'file') return; try { const path = localPath(goal.cwd, goal.completion.path), file = await this.options.read(goal.cwd, path); if (file.text.includes(goal.completion.contains) && file.digest) return { path, digest: file.digest, label: '验收文件文字已匹配' }; } catch { /* Missing or unreadable is not completed. */ } }
  private finishGoal(goalId: string, status: Goal['status'], reason: string) { this.save(data => { const goal = data.goals.find(g => g.id === goalId)!; goal.status = status; goal.reason = reason.slice(0, 2000); goal.updatedAt = this.at(); }); }
  async controlGoal(goalId: string, action: 'pause' | 'stop' | 'accept') { this.writable(); const goal = this.goal(goalId); this.launches.delete(goalId); if (action === 'accept') { if (goal.status !== 'review') throw new Error('仅等待验收的任务可以确认完成'); this.finishGoal(goalId, 'completed', '用户已确认验收'); return; } const entry = this.active.get(goalId); if (entry) { entry.stoppedAt = this.now(); entry.controller.abort(); } this.finishGoal(goalId, action === 'stop' ? 'stopped' : 'paused', action === 'stop' ? '用户停止任务，不再自动继续' : '用户暂停，预算消耗累计保留'); if (entry?.done) await entry.done; }
  private checkpointTool(): ToolDefinition { const owner = this; return { name: 'task_checkpoint', description: 'Record a milestone for this managed goal only. continue means another bounded round is needed; review requests HUMAN acceptance, never claims user approval; blocked records a real blocker. Evidence is a model-provided lead, not a verified result. Cannot change budget, permissions, memory or schedules.', inputSchema: { type:'object',properties:{status:{type:'string',enum:['continue','review','blocked']},summary:{type:'string',minLength:1,maxLength:2000}},required:['status','summary'],additionalProperties:false }, available: ctx => [...owner.active.values()].some(active => active.threadId === ctx.threadId && owner.store.data.goals.some(g => g.id === active.owner && g.status === 'running')), subject:()=> 'own-goal-milestone',summarize:()=> '记录持续任务节点', async *run(input,ctx) { const active = [...owner.active.values()].find(active => active.threadId === ctx.threadId); if (!active || active.controller.signal.aborted) { yield {type:'result',text:'持续任务已停止',isError:true};return; } const value = input as any; active.report = {status:value.status,summary:boundText(value.summary,'进度说明',2000)}; owner.changed(); yield {type:'result',text:JSON.stringify({managedCheckpoint:true,status:active.report.status,summary:active.report.summary})}; } }; }
  private message(error: unknown) { return this.vault.redact(error instanceof Error ? error.message : String(error)).slice(0, 2000); }
  private claim(ownerId: string, kind: ManagedRun['kind'], slot: string, threadId?: string) { const run: ManagedRun = { id:id('run'),ownerId,kind,slot,threadId,status:'running',startedAt:this.at(),evidence:[] }; this.save(data => { data.runs.push(run); }); return run; }
  private endRun(runId: string, status: ManagedRun['status'], patch: Partial<ManagedRun> = {}) { this.save(data => { const run = data.runs.find(run => run.id === runId); if (run) { Object.assign(run,patch,{status,endedAt:this.at()}); const schedule = run.kind === 'schedule' ? data.schedules.find(s => s.id === run.ownerId) : undefined; if (schedule && (patch.reason || ['failed','interrupted','budget'].includes(status))) { const label = status === 'failed' ? '本次运行失败' : status === 'interrupted' ? '本次运行已中断' : status === 'budget' ? '本次运行达到预算' : status === 'skipped' ? '本时段跳过' : '本次运行需核对'; schedule.reason = (label + '：' + (patch.reason ?? '请打开运行记录核对实际结果')).slice(0,2000); schedule.updatedAt = this.at(); } } }); }
  private stopLabel(reason?: string) { return reason ? ({ requests:'模型请求预算已用完',tokens:'Token 预算不足',tools:'工具操作预算已用完',deadline:'运行时间已达到上限',context:'上下文需要手动检查' } as Record<string,string>)[reason] ?? reason : undefined; }
  private resultReason(threadId:string,outcome:TurnOutcome) {
    if(outcome.error||outcome.stopReason)return outcome.error??this.stopLabel(outcome.stopReason);
    const assessment=outcome.summary?.assessment;if(!assessment||assessment.status==='completed')return;
    const unresolved=new Set(assessment.unresolved),items=this.options.kernel.threads.read(threadId).items.filter(item=>item.turnId===outcome.turnId);
    const reasons=items.flatMap(item=>{if(item.kind!=='commandExecution'&&item.kind!=='mcpToolCall')return[];if(!unresolved.has(item.id)&&!(item.kind==='commandExecution'&&['finding','unverified'].includes(item.assessment?.kind??'')))return[];const lines=item.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!v.startsWith('[exit'));const line=lines.find(v=>/Error|Exception|denied|Would reformat|失败|拒绝|未获授权/.test(v))??lines[0];return line?[`${item.kind==='commandExecution'?item.tool??'操作':item.server+'/'+item.tool}：${line.slice(0,280)}`]:[];}).slice(0,3);
    return reasons.length?reasons.join('；'):assessment.pendingSteps?`${assessment.pendingSteps} 个计划步骤尚未完成`:assessment.verificationMissing?'修改后尚未运行匹配范围的验证':assessment.checks.skipped?`${assessment.checks.skipped} 项检查已跳过，未计为通过`:'本轮仍有需核对事项，请打开对话检查实际记录';
  }
  async saveSchedule(raw: any, scheduleId?: string, revision?: number) { return this.serial(async () => {
    this.writable(); const common = commonTask(raw); await this.options.scope(common, true); this.options.modelFingerprint(common.model); const timing = timingConfig(raw.timing), budget = budgetConfig(raw.budget,true); if (!Number.isSafeInteger(raw.maxRuns) || raw.maxRuns < 1 || raw.maxRuns > 1000) throw new Error('最多执行次数必须为 1～1000');
    const endsAt = raw.endsAt ? stamp(Date.parse(raw.endsAt)) : undefined; if (endsAt && Date.parse(endsAt) <= this.now()) throw new Error('结束时间必须在未来');
    const old = scheduleId ? this.schedule(scheduleId) : undefined; if (old) { this.ensureRevision(old,revision); if (this.active.has(old.id)) throw new Error('请先停止本次运行再修改配置'); }
    const references = await this.referenceSnapshots(common.cwd,raw.references ?? []), memoryIds = this.checkedMemoryIds(raw.memoryIds ?? [],common);
    const value: Schedule = { ...common,id:old?.id ?? id('schedule'),revision:(old?.revision ?? 0)+1,enabled:false,executions:0,timing,budget:{requests:budget.requests,tools:budget.tools,tokens:budget.tokens,minutes:budget.minutes},maxRuns:raw.maxRuns,endsAt,references,memoryIds,createdAt:old?.createdAt ?? this.at(),updatedAt:this.at() };
    this.recheck('schedules',scheduleId,revision); this.vault.remove(value.id); this.save(data => { data.schedules = [...data.schedules.filter(s=>s.id!==value.id),value]; }); return value;
  }); }
  private async referenceSnapshots(cwd: string, values: unknown): Promise<Evidence[]> { if (!Array.isArray(values) || values.length > 6) throw new Error('最多固定 6 项工作区资料'); const result:Evidence[]=[]; for (const raw of values) { const path = localPath(cwd,typeof raw==='string'?raw:raw?.path),file=await this.options.read(cwd,path);if (!file.digest) throw new Error('资料缺少版本标识');result.push({path,digest:file.digest,label:typeof raw?.label==='string'?raw.label.slice(0,200):path}); }return result; }
  private checkedMemoryIds(values: unknown, scope: Scope): string[] { if (!Array.isArray(values)||values.length>4||values.some(value=>typeof value!=='string')) throw new Error('最多选择 4 项记忆');return [...new Set(values)].map(value=>{this.memory(value,scope);return value;}); }
  private async validateSnapshots(scope: Scope, refs: Evidence[]) { await this.options.scope(scope,false); for (const ref of refs) { localPath(scope.cwd,ref.path);const current=await this.options.read(scope.cwd,ref.path);if(current.digest!==ref.digest)throw new Error('引用资料已变化，请编辑任务重新固定快照：'+ref.path); } }
  async configureSchedule(scheduleId: string, enabled: boolean) {
    this.writable(); const value=this.schedule(scheduleId);if (!enabled) { this.vault.remove(value.id);this.save(data=>{const s=data.schedules.find(s=>s.id===scheduleId)!;s.enabled=false;s.reason='已停用未来调度';s.updatedAt=this.at();});await this.stopRun(scheduleId);return; }
    if (this.active.has(scheduleId)) throw new Error('请先停止本次运行，再重新启用预算');
    if (this.launches.has(scheduleId)) throw new Error('正在处理启用操作');this.launches.add(scheduleId);
    try { await this.options.scope(value,true);await this.validateSnapshots(value,value.references); const binding=this.binding(value), next=nextSlot(value.timing,this.now(),value.lastSlot);if(!next||value.endsAt&&next>Date.parse(value.endsAt))throw new Error('没有未来执行时段，请修改时间');
      if(!await this.options.consent('启用本机定时任务',`${value.title}\n工作区：${value.cwd}\n模型：${value.model}\n下一次：${stamp(next)}\n最多执行：${value.maxRuns} 次；单次 ${value.budget.requests} 请求 / ${value.budget.tokens} Token / ${value.budget.minutes} 分钟。\n\n仅允许工作区内的读取、搜索与计划，不执行命令、改文件、MCP、项目 Hooks 或交互审批。引用资料和所选记忆将发送给所选模型。应用须保持运行；休眠/离线错过时段不补跑，失败不自动重试。`))throw new Error('已取消启用');
      if(!this.launches.has(scheduleId)||this.stopped||this.schedule(scheduleId).revision!==value.revision||this.binding(value)!==binding)throw new Error('配置或模型端点已变化，请重新核对');
      this.vault.save(value.id,binding,{approved:true,claims:0});this.save(data=>{const s=data.schedules.find(s=>s.id===value.id)!;s.enabled=true;s.executions=0;s.nextAt=stamp(next);s.reason=undefined;s.updatedAt=this.at();});
    }finally{this.launches.delete(scheduleId);}
  }
  async tick() {
    if(this.ticking||this.stopped||this.closing||this.suspended||this.store.notice||this.vault.notice)return;this.ticking=true;
    try { for(const schedule of [...this.store.data.schedules]) { if(!schedule.enabled||!schedule.nextAt||Date.parse(schedule.nextAt)>this.now())continue; await this.dispatch(schedule,false);await new Promise<void>(resolve=>setImmediate(resolve)); } }finally{this.ticking=false;}
  }
  async runSchedule(scheduleId:string) { this.writable();const value=this.schedule(scheduleId);if(!value.enabled||!this.approved(value))throw new Error('请先核对并启用定时任务');return this.dispatch(value,true); }
  private async dispatch(value:Schedule,manual:boolean) {
    if(this.active.has(value.id)||this.launches.has(value.id)) {if(manual)throw new Error('本任务仍在运行，不会重叠执行');if(value.nextAt){const slot=slotKey(value.timing,Date.parse(value.nextAt));const skipped=this.claim(value.id,'schedule',slot);this.endRun(skipped.id,'skipped',{reason:'上次运行尚未结束，本时段跳过'});this.advance(value.id,nextSlot(value.timing,this.now(),slot),slot,'上次运行尚未结束，本时段跳过');}return;}
    // Reserve before the first await. Pending starts/consent also own a slot.
    if(this.occupied()+(this.options.externalSlots?.()??0)>=2){if(manual)throw new Error('同时运行已达到两项上限');if(value.nextAt){const slot=slotKey(value.timing,Date.parse(value.nextAt)),run=this.claim(value.id,'schedule',slot);this.endRun(run.id,'skipped',{reason:'托管任务并发已满，此时段跳过'});this.advance(value.id,nextSlot(value.timing,this.now(),slot),slot,'托管任务并发已满，此时段跳过');}return;}
    this.launches.add(value.id);
    try {
      if(!this.approved(value)){this.disableSchedule(value.id,'授权已失效或模型端点变化，请重新启用');return;}
      const binding=this.binding(value),grant=this.vault.get(value.id,binding),at=manual?this.now():Date.parse(value.nextAt!),slot=manual?'manual:'+id('slot'):slotKey(value.timing,at);
      const next=nextSlot(value.timing,this.now(),value.timing.kind==='daily'?slotKey(value.timing,at):slot),skip=async(reason:string)=>{const run=this.claim(value.id,'schedule',slot);this.endRun(run.id,'skipped',{reason});this.advance(value.id,next,slot,reason);};
      if((grant.claims??0)>=value.maxRuns||value.endsAt&&this.now()>=Date.parse(value.endsAt)){this.disableSchedule(value.id,'已达到执行次数或结束时间');return;}
      if(!manual&&(grant.lastSlot===slot||grant.lastClaimAt&&at<=grant.lastClaimAt)){this.advance(value.id,next,slot,'该时段已认领，不重放');return;}
      if(!manual&&this.now()-at>60000){await skip('错过执行时段，不补跑');return;}
      if(!this.options.online()){if(manual)throw new Error('当前离线');await skip('执行时段离线，未调用模型；未来时段继续');return;}
      if(this.active.size+(this.options.externalSlots?.()??0)>=2){if(manual)throw new Error('同时运行已达到两项上限');await skip('托管任务并发已满，此时段跳过');return;}
      await this.validateSnapshots(value,value.references);this.checkedMemoryIds(value.memoryIds,value);
      if(this.active.size+(this.options.externalSlots?.()??0)>=2){if(manual)throw new Error('同时运行已达到两项上限');await skip('托管任务并发已满，此时段跳过');return;}
      if(this.stopped||this.suspended||!this.schedule(value.id).enabled||this.binding(this.schedule(value.id))!==binding||!this.approved(value))return;
      // Claim in the encrypted ledger BEFORE creating a conversation or making a request.
      const runId=id('run');this.vault.save(value.id,binding,{...grant,approved:true,claims:(grant.claims??0)+1,lastClaimAt:at,lastSlot:slot,lastRunId:runId});
      this.advance(value.id,next,slot,undefined,(grant.claims??0)+1);
      const rt=this.options.kernel.threads.start({cwd:value.cwd,projectId:value.projectId,model:value.model,title:value.title+' · '+new Date(this.now()).toLocaleString(),permissionMode:'plan'}),run:ManagedRun={id:runId,kind:'schedule',ownerId:value.id,slot,status:'running',threadId:rt.meta.id,startedAt:this.at(),evidence:value.references};
      this.save(data=>data.runs.push(run));const active:Active={owner:value.id,runId,threadId:rt.meta.id,controller:new AbortController(),started:this.now()};this.active.set(value.id,active);
      active.done=this.executeSchedule(value,active).catch(error=>{try {this.endRun(runId,'failed',{reason:this.message(error)});}catch(failure){this.fatal(failure);}}).finally(()=>{this.active.delete(value.id);this.changed();});return {threadId:rt.meta.id};
    }catch(error){this.disableSchedule(value.id,this.message(error));if(manual)throw error;}
    finally{this.launches.delete(value.id);}
  }
  private advance(scheduleId:string,next:number|undefined,slot:string,reason?:string,executions?:number){this.save(data=>{const s=data.schedules.find(s=>s.id===scheduleId)!;s.lastSlot=slot;s.nextAt=next?stamp(next):undefined;s.reason=reason;if(executions!==undefined)s.executions=executions;if(!next||s.endsAt&&next>Date.parse(s.endsAt)||s.executions>=s.maxRuns)s.enabled=false;});}
  private disableSchedule(scheduleId:string,reason:string){this.save(data=>{const s=data.schedules.find(s=>s.id===scheduleId);if(s){s.enabled=false;s.reason=reason;s.nextAt=undefined;}});}
  private skipMissed(reason:string) {
    if (!this.store.data.schedules.some(s=>s.enabled&&s.nextAt&&Date.parse(s.nextAt)<=this.now())) return;
    this.save(data=>{for(const s of data.schedules){if(!s.enabled||!s.nextAt||Date.parse(s.nextAt)>this.now())continue;const slot=slotKey(s.timing,Date.parse(s.nextAt)),next=nextSlot(s.timing,this.now(),slot);data.runs.push({id:id('run'),kind:'schedule',ownerId:s.id,slot,status:'skipped',startedAt:this.at(),endedAt:this.at(),reason,evidence:[]});s.lastSlot=slot;s.nextAt=next?stamp(next):undefined;s.reason=reason;if(!next||s.endsAt&&next>Date.parse(s.endsAt)||s.executions>=s.maxRuns)s.enabled=false;}});
  }
  private async executeSchedule(value:Schedule,active:Active){
    try { const context=await this.options.context(value.cwd,value.references),refs=[...context.references,...value.memoryIds.map(memoryId=>{const m=this.memory(memoryId,value);return{path:this.memoryPath(m),label:'记忆 · '+m.title};})];const prepared=await this.prepareMessage(active.threadId,value.instructions+context.text,refs,'managed',active.runId,false);
      const outcome=await this.options.kernel.threads.runManaged(active.threadId,{text:prepared.input,displayText:value.instructions,references:prepared.references,images:context.images},{maxRequests:value.budget.requests,maxTokens:value.budget.tokens,maxTools:value.budget.tools,deadlineAt:Date.now()+value.budget.minutes*60000-Math.max(0,this.now()-active.started),unattended:true,signal:active.controller.signal});
      this.endRun(active.runId,outcome.failed?'failed':outcome.stopReason?'budget':outcome.interrupted?'interrupted':'completed',{turnId:outcome.turnId,reason:this.resultReason(active.threadId,outcome),summary:outcome.assistantText.slice(-3000),metrics:outcome.metrics,usage:outcome.usage});
    }finally{await this.options.cleanup(active.threadId);}
  }
  async stopRun(ownerId:string){this.launches.delete(ownerId);const active=this.active.get(ownerId);if(active){active.stoppedAt=this.now();active.controller.abort();await active.done;}}
  private memory(memoryId:string,scope?:Pick<Scope,'canonical'|'projectId'>):Memory{const value=this.store.data.memories.find(memory=>memory.id===memoryId);if(!value)throw new Error('记忆已删除或不存在');if(scope&&(value.canonical!==scope.canonical||value.projectId&&value.projectId!==scope.projectId))throw new Error('记忆不属于当前项目或工作区');if(autonomyDigest(memoryConfig(value))!==value.digest)throw new Error('记忆内容已变化，请重新保存确认');return value;}
  memoryPath(memory:Memory){return 'memory:'+memory.id+'@'+memory.digest;}
  readMemory(path:string,cwd:string){const match=/^memory:(memory_[a-f0-9-]{36})@([a-f0-9]{64})$/.exec(path);if(!match)throw new Error('记忆引用无效');const memory=this.memory(match[1]!);if(memory.canonical!==canonical(cwd))throw new Error('记忆不属于当前工作区');if(memory.projectId){const value=this.store.data.memories.find(m=>m.id===match[1]);if(!value||value.canonical!==canonical(cwd))throw new Error('记忆范围不匹配');}if(memory.digest!==match[2])throw new Error('记忆已更新，请移除旧引用后重新选择');return memory;}
  async saveMemory(raw:unknown,memoryId?:string,revision?:number){return this.serial(async()=>{this.writable();const config=memoryConfig(raw);await this.options.scope(config,true);const old=memoryId?this.memory(memoryId):undefined;if(old)this.ensureRevision(old,revision);
    if(config.source.kind==='conversation'){const source=this.options.kernel.threads.read(config.source.threadId!);if(canonical(source.meta.cwd)!==config.canonical||config.projectId&&source.meta.projectId!==config.projectId||!source.items.some(item=>item.id===config.source.itemId&&(item.kind==='agentMessage'||item.kind==='userMessage')))throw new Error('记忆来源不属于选定项目或消息已失效');}
    const value:Memory={...config,id:old?.id??id('memory'),digest:autonomyDigest(config),revision:(old?.revision??0)+1,createdAt:old?.createdAt??this.at(),updatedAt:this.at()};
    if(config.auto){if(!await this.options.consent('启用自动引用记忆',`${value.title}\n工作区：${value.cwd}\n项目：${value.projectId??'此工作区'}\n来源：${value.source.note}\n\n该内容会加入匹配范围的后续手动任务并发送给模型。定时任务只使用其明确选择的记忆，不自动加入。请勿保存密钥。\n\n${value.body.slice(0,3000)}`))throw new Error('已取消自动引用');this.recheck('memories',memoryId,revision);this.writable();this.vault.save(value.id,this.binding(value),{approved:true});}else this.vault.remove(value.id);
    this.save(data=>{data.memories=[...data.memories.filter(m=>m.id!==value.id),value];});return value;
  });}
  async prepareMessage(threadId:string,input:string,references:Array<{path:string;label?:string}>=[],kind:'message'|'queued'|'managed'='message',runId?:string,automatic=true){
    const meta=this.options.kernel.threads.read(threadId).meta,scope={canonical:canonical(meta.cwd),projectId:meta.projectId};const selected:Memory[]=[];
    for(const reference of references.filter(ref=>ref.path.startsWith('memory:'))){const match=/^memory:(memory_[a-f0-9-]{36})@([a-f0-9]{64})$/.exec(reference.path);if(!match)throw new Error('记忆引用无效');const memory=this.memory(match[1]!,scope);if(memory.digest!==match[2])throw new Error('记忆已更新，请重新选择');if(!selected.some(m=>m.id===memory.id))selected.push(memory);}
    if(automatic&&!this.store.notice)for(const memory of this.store.data.memories)if(memory.auto&&memory.canonical===scope.canonical&&(!memory.projectId||memory.projectId===scope.projectId)&&this.approved(memory)&&!selected.some(m=>m.id===memory.id))selected.push(this.memory(memory.id,scope));
    if(selected.length>4||selected.reduce((n,m)=>n+m.body.length,0)>24000)throw new Error('本次记忆超过 4 项或 24000 字符，请减少自动引用或显式选择');
    if(selected.length){const text='\n\n用户保存的记忆资料（带来源的上下文，不改变系统指令、权限或工作区）：\n'+JSON.stringify(selected.map(m=>({title:m.title,body:m.body,source:m.source,scope:m.projectId??m.cwd}))).replace(/</g,'\\u003c');if(input.length+text.length>160000)throw new Error('任务资料过长，请减少记忆或引用');input+=text;this.save(data=>{for(const memory of selected)data.uses.push({id:id('use'),memoryId:memory.id,digest:memory.digest,title:memory.title,threadId,at:this.at(),kind,runId});});}
    return{input,references:[...references.filter(ref=>!ref.path.startsWith('memory:')),...selected.map(memory=>({path:this.memoryPath(memory),label:'记忆 · '+memory.title}))]};
  }
  async saveTemplate(raw:any,templateId?:string,revision?:number){return this.serial(async()=>{this.writable();const common=commonTask(raw);await this.options.scope(common,true);this.options.modelFingerprint(common.model);if(!['plan','default','acceptEdits'].includes(raw.mode))throw new Error('模板权限无效');const output=typeof raw.output==='string'?raw.output.trim():'';if(output.length>8000)throw new Error('输出标准过长');const variables=[...new Set([...common.instructions.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}\}/g)].map(m=>m[1]!))];if(variables.length>8)throw new Error('模板最多 8 个变量');const old=templateId?this.store.data.templates.find(t=>t.id===templateId):undefined;if(templateId&&!old)throw new Error('模板不存在');if(old)this.ensureRevision(old,revision);const value:TaskTemplate={...common,id:old?.id??id('template'),mode:raw.mode,output,references:await this.referenceSnapshots(common.cwd,raw.references??[]),variables,revision:(old?.revision??0)+1,createdAt:old?.createdAt??this.at(),updatedAt:this.at()};this.recheck('templates',templateId,revision);this.save(data=>{data.templates=[...data.templates.filter(t=>t.id!==value.id),value];});return value;});}
  async applyTemplate(templateId:string,revision:number,values:unknown){this.writable();const template=this.store.data.templates.find(t=>t.id===templateId);if(!template)throw new Error('模板不存在');this.ensureRevision(template,revision);await this.options.scope(template,true);await this.validateSnapshots(template,template.references);this.options.modelFingerprint(template.model);if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(key=>!template.variables.includes(key)))throw new Error('模板变量无效');const vars=values as Record<string,unknown>;for(const key of template.variables)boundText(vars[key],'模板变量 '+key,4000);const text=template.instructions.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}\}/g,(_,key)=>String(vars[key]))+(template.output?'\n\n输出标准：\n'+template.output:'');if(text.length>40000)throw new Error('套用后的任务过长');this.recheck('templates',templateId,revision);const rt=this.options.kernel.threads.start({cwd:template.cwd,projectId:template.projectId,model:template.model,title:template.title,permissionMode:template.mode});return{threadId:rt.meta.id,text,references:template.references};}
  async remove(kind:'goal'|'schedule'|'memory'|'template',valueId:string,revision:number){this.writable();const key=kind==='memory'?'memories':kind==='goal'?'goals':kind==='schedule'?'schedules':'templates',value=this.store.data[key].find(value=>value.id===valueId);if(!value)throw new Error('内容不存在');this.ensureRevision(value,revision);if(kind==='goal'&&this.goal(valueId).status==='running')await this.controlGoal(valueId,'stop');else await this.stopRun(valueId);this.vault.remove(valueId);this.save(data=>{(data as any)[key]=(data as any)[key].filter((value:any)=>value.id!==valueId);if(kind==='memory')data.uses=data.uses.filter(use=>use.memoryId!==valueId);});}
  async suspend(){this.suspended=true;this.launches.clear();for(const value of this.active.values()){value.stoppedAt=this.now();value.controller.abort();}for(const goal of this.store.data.goals)if(goal.status==='running'&&!this.store.notice)this.finishGoal(goal.id,'paused','系统休眠，任务已暂停；唤醒后需手动继续');this.changed();}
  resume(){if(this.stopped||this.closing)return;try{if(!this.store.notice&&!this.vault.notice)this.skipMissed('系统休眠时错过时段，已跳过且不补跑');this.suspended=false;this.changed();void this.tick().catch(error=>this.fatal(error));}catch(error){this.fatal(error);}}
  async shutdown(){this.closing=true;if(this.timer)clearInterval(this.timer);this.suspended=true;this.launches.clear();for(const value of this.active.values()){value.stoppedAt=this.now();value.controller.abort();}for(const goal of this.store.data.goals)if(goal.status==='running'&&!this.store.notice){try{this.finishGoal(goal.id,'paused','应用退出，需用户手动继续');}catch(error){this.fatal(error);}}await Promise.all([...this.active.values()].map(value=>value.done));this.stopped=true;if(this.notification)clearTimeout(this.notification);}
}
