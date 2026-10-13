import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/core/kernel.js';
import { loadSettings } from '../src/config/settings.js';
import { trustProject, isProjectTrusted } from '../src/config/trust.js';
import { ModelError, type ModelDelta, type ModelStreamer } from '../src/models/types.js';
import { replayEvents } from '../src/storage/thread-store.js';
import type { ApprovalRequest, ApprovalDecision } from '../src/protocol/types.js';

let root: string, cwd: string, previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smalt-integration-'));
  cwd = join(root, 'workspace'); mkdirSync(cwd);
  previousHome = process.env.SMALT_HOME; process.env.SMALT_HOME = join(root, 'home');
});
afterEach(() => { vi.restoreAllMocks(); if (previousHome === undefined) delete process.env.SMALT_HOME; else process.env.SMALT_HOME = previousHome; rmSync(root, { recursive: true, force: true }); });
const tool = (name: string, input: unknown): ModelDelta[] => [{ type: 'toolCallStart', id: 'call_' + Math.random().toString(36).slice(2), name }, { type: 'done', finishReason: 'toolCalls' }];
function kernel(scripts: Array<{ name?: string; input?: unknown; text?: string; error?: Error }>, approve: (req: ApprovalRequest) => Promise<ApprovalDecision> = async () => ({ decision: 'allow' })) {
  const events: Array<{ method: string; params: any }> = [];
  const requests: Array<any> = [];
  let index = 0;
  const k = new Kernel({ cwd, client: { notify: (method, params) => events.push({ method, params }), requestApproval: approve, askUser: async () => '中文' } });
  vi.spyOn(k.gateway, 'fork').mockReturnValue(k.gateway);
  vi.spyOn(k.gateway, 'stream').mockImplementation(async function* (_ref, req) {
    requests.push(structuredClone(req.messages));
    const response = scripts[Math.min(index++, scripts.length - 1)]!;
    if (response.error) throw response.error;
    if (response.name) { const id = 'call_' + index; yield { type: 'toolCallStart', id, name: response.name }; yield { type: 'toolCallDelta', id, argsDelta: JSON.stringify(response.input ?? {}) }; yield { type: 'done', finishReason: 'toolCalls' }; }
    else { yield { type: 'text', text: response.text ?? 'done' }; yield { type: 'done', finishReason: 'stop' }; }
  });
  return { k, events, requests };
}
async function start(k: Kernel, extra: object = {}) { return (await k.handle('thread/start', { cwd, ...extra }) as { threadId: string }).threadId; }

describe('desktop protocol integration regressions', () => {
  it('continues past the former 50-step wall and completes naturally', async () => {
    const previous = process.env.SMALT_MAX_STEPS; delete process.env.SMALT_MAX_STEPS;
    try {
      const scripts = [...Array.from({ length: 72 }, () => ({ name: 'plan', input: { steps: [{ content: '持续执行', status: 'inProgress' }] } })), { text: 'completed after 72 tools' }];
      const { k, requests } = kernel(scripts); const id = await start(k);
      expect(await k.handle('turn/start', { threadId: id, input: 'long task' })).toMatchObject({ failed: false, assistantText: 'completed after 72 tools' });
      expect(requests).toHaveLength(73);
    } finally { if (previous === undefined) delete process.env.SMALT_MAX_STEPS; else process.env.SMALT_MAX_STEPS = previous; }
  });
  it('can interrupt a continuous task after more than 50 steps', async () => {
    const { k, requests } = kernel([{ name: 'plan', input: { steps: [] } }]);
    const id = await start(k); let count = 0;
    vi.spyOn(k.gateway, 'stream').mockImplementation(async function* () {
      if (++count > 65) { await k.handle('turn/interrupt', { threadId: id }); return; }
      const call = 'long_' + count; yield { type: 'toolCallStart', id: call, name: 'plan' }; yield { type: 'toolCallDelta', id: call, argsDelta: '{"steps":[]}' }; yield { type: 'done', finishReason: 'toolCalls' };
    });
    expect(await k.handle('turn/start', { threadId: id, input: 'work continuously' })).toMatchObject({ interrupted: true, failed: false });
    expect(count).toBe(66); expect(k.threads.status(id).lifecycle).toBe('idle');
  });
  it('switches permissions during a pending approval and unblocks eligible edits immediately', async () => {
    let ready!: () => void; const waiting = new Promise<void>(r => ready = r);
    const { k } = kernel([{ name: 'write', input: { path: 'live.txt', content: 'allowed' } }, { name: 'write', input: { path: 'next.txt', content: 'also allowed' } }, { text: 'done' }], async () => { ready(); return new Promise(() => {}); });
    const id = await start(k); const run = k.handle('turn/start', { threadId: id, input: 'write' }); await waiting;
    await k.handle('thread/settings/update', { threadId: id, permissionMode: 'acceptEdits' });
    expect(await run).toMatchObject({ failed: false });
    expect(readFileSync(join(cwd, 'live.txt'), 'utf8')).toBe('allowed'); expect(readFileSync(join(cwd, 'next.txt'), 'utf8')).toBe('also allowed');
    expect(k.threads.read(id).meta.permissionMode).toBe('acceptEdits');
  });
  it('a live switch to plan cancels pending edits without writing them', async () => {
    let ready!: () => void; const waiting = new Promise<void>(r => ready = r);
    const { k } = kernel([{ name: 'write', input: { path: 'no.txt', content: 'never' } }, { text: 'done' }], async () => { ready(); return new Promise(() => {}); });
    const id = await start(k); const run = k.handle('turn/start', { threadId: id, input: 'write' }); await waiting;
    await k.handle('thread/settings/update', { threadId: id, permissionMode: 'plan' }); await run;
    expect(() => readFileSync(join(cwd, 'no.txt'))).toThrow();
    expect(k.threads.read(id).items.some(i => i.status === 'blocked')).toBe(true);
  });
  it('groups write and apply_patch approvals within one conversation, but keeps other conversations separate', async () => {
    let approvals = 0;
    const { k } = kernel([{ name: 'write', input: { path: 'one.txt', content: 'x' } }, { name: 'write', input: { path: 'two.txt', content: 'x' } }, { name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: three.txt\n+x\n*** End Patch' } }, { text: 'done' }, { name: 'write', input: { path: 'other.txt', content: 'x' } }, { text: 'done' }], async () => { approvals++; return { decision: 'allow', scope: 'category' }; });
    const a = await start(k), b = await start(k);
    await k.handle('turn/start', { threadId: a, input: 'edit files' }); expect(approvals).toBe(1);
    expect(readFileSync(join(cwd, 'three.txt'), 'utf8')).toBe('x\n');
    await k.handle('turn/start', { threadId: b, input: 'another conversation' }); expect(approvals).toBe(2);
  });
  it('approves only the listed batch, and asks again for a new batch', async () => {
    const groups: ApprovalRequest[] = [];
    const { k } = kernel([], async req => { groups.push(req); return { decision: 'allow', scope: 'batch' }; });
    let request = 0;
    vi.spyOn(k.gateway, 'stream').mockImplementation(async function* () {
      request++;
      const paths = request === 1 ? ['batch-a.txt', 'batch-b.txt'] : request === 2 ? ['later.txt'] : [];
      for (const [index, path] of paths.entries()) { const id = `batch_${request}_${index}`; yield { type: 'toolCallStart', id, name: 'write' }; yield { type: 'toolCallDelta', id, argsDelta: JSON.stringify({ path, content: 'approved' }) }; }
      if (!paths.length) yield { type: 'text', text: 'done' };
      yield { type: 'done', finishReason: paths.length ? 'toolCalls' : 'stop' };
    });
    const id = await start(k); await k.handle('turn/start', { threadId: id, input: 'batch' });
    expect(groups).toHaveLength(2); expect(groups[0].batch?.map(op => (op.input as any).path)).toEqual(['batch-a.txt', 'batch-b.txt']); expect(groups[1].batch).toBeUndefined();
    expect(readFileSync(join(cwd, 'batch-b.txt'), 'utf8')).toBe('approved');
  });
  it('persists category approval across restarts and can revoke it', async () => {
    const { k } = kernel([{ name: 'write', input: { path: 'saved-permission.txt', content: 'x' } }, { text: 'done' }], async () => ({ decision: 'allow', scope: 'category' }));
    const id = await start(k); await k.handle('turn/start', { threadId: id, input: 'write' });
    let prompts = 0;
    const { k: restarted } = kernel([{ name: 'write', input: { path: 'after-restart.txt', content: 'x' } }, { text: 'done' }, { name: 'write', input: { path: 'after-revoke.txt', content: 'x' } }, { text: 'done' }], async () => { prompts++; return { decision: 'deny' }; });
    await restarted.handle('thread/resume', { threadId: id });
    await restarted.handle('turn/start', { threadId: id, input: 'again' }); expect(prompts).toBe(0); expect(readFileSync(join(cwd, 'after-restart.txt'), 'utf8')).toBe('x');
    await restarted.handle('thread/permissions/reset', { threadId: id });
    await restarted.handle('turn/start', { threadId: id, input: 'revoked' }); expect(prompts).toBe(1); expect(() => readFileSync(join(cwd, 'after-revoke.txt'))).toThrow();
    expect(restarted.store.listMetas()[0].approvedCategories).toBeUndefined();
  });
  it('global permission updates also affect a running conversation', async () => {
    let ready!: () => void; const waiting = new Promise<void>(r => ready = r);
    const { k } = kernel([{ name: 'write', input: { path: 'global.txt', content: 'never' } }, { text: 'done' }], async () => { ready(); return new Promise(() => {}); });
    const id = await start(k); const run = k.handle('turn/start', { threadId: id, input: 'write' }); await waiting;
    const next = structuredClone(k.getSettings()); next.permissions.deny.push('write'); k.applySettings(next); await run;
    expect(() => readFileSync(join(cwd, 'global.txt'))).toThrow();
  });
  it('persists projects, injects their instructions and restores/deletes archived conversations', async () => {
    const { k, requests } = kernel([{ text: 'project answer' }]);
    const project = (await k.handle('project/create', { name: '开发项目', instructions: 'Always explain in Chinese. UNIQUE_PROJECT_CONTEXT', cwd }) as any).project;
    const id = await start(k, { projectId: project.id }); await k.handle('turn/start', { threadId: id, input: 'hello' });
    expect(requests[0].some((m: any) => m.role === 'system' && m.content.includes('UNIQUE_PROJECT_CONTEXT'))).toBe(true);
    expect(new Kernel({ cwd, client: { notify() {}, requestApproval: async () => ({ decision: 'deny' }), askUser: async () => '' } }).projects.require(project.id).name).toBe('开发项目');
    await k.handle('thread/archive', { threadId: id });
    expect((await k.handle('thread/list', {}) as any).threads).toHaveLength(0);
    expect((await k.handle('thread/list', { includeArchived: true }) as any).threads[0]).toMatchObject({ archived: true, projectId: project.id });
    await k.handle('thread/read', { threadId: id }); await expect(k.handle('turn/start', { threadId: id, input: 'blocked' })).rejects.toThrow('Restore');
    await k.handle('thread/restore', { threadId: id }); expect(k.threads.read(id).meta.archived).toBe(false);
    await k.handle('project/delete', { projectId: project.id }); expect(k.threads.read(id).meta.projectId).toBeUndefined();
    await k.handle('thread/archive', { threadId: id }); await k.handle('thread/delete', { threadId: id });
    expect(k.store.load(id)).toBeNull(); expect(k.threads.listMetas(true)).toHaveLength(0);
  });
  it('saves plain assistant replies in the next live request and in persisted history', async () => {
    const { k, requests } = kernel([{ text: 'first answer' }, { text: 'second answer' }]);
    const id = await start(k);
    await k.handle('turn/start', { threadId: id, input: 'first' });
    await k.handle('turn/start', { threadId: id, input: 'second' });
    expect(requests[1].some((m: any) => m.role === 'assistant' && m.content === 'first answer')).toBe(true);
    expect(replayEvents(k.store.load(id)!).history.filter(m => m.role === 'assistant')).toHaveLength(2);
  });
  it('hot reloads permissions before the next turn', async () => {
    const { k } = kernel([{ name: 'write', input: { path: 'blocked.txt', content: 'x' } }, { text: 'done' }]);
    const settings = k.getSettings(); settings.permissions.deny.push('write'); k.applySettings(settings);
    const id = await start(k);
    await k.handle('turn/start', { threadId: id, input: 'write' });
    expect(k.threads.read(id).items.some(i => i.kind === 'fileChange' && i.status === 'blocked')).toBe(true);
    expect(() => readFileSync(join(cwd, 'blocked.txt'))).toThrow();
  });
  it('emits stable streamed item ids and real lifecycle events', async () => {
    const { k, events } = kernel([{ text: 'stream me' }]); const id = await start(k);
    await k.handle('turn/start', { threadId: id, input: 'hello' });
    const delta = events.find(e => e.method === 'item/agentMessage/delta')!;
    const completed = events.find(e => e.method === 'item/completed' && e.params.item.kind === 'agentMessage')!;
    expect(delta.params.itemId).toBe(completed.params.item.id);
    expect(events.filter(e => e.method === 'thread/status/changed').map(e => e.params.lifecycle)).toContain('running');
    expect(events.filter(e => e.method === 'thread/status/changed').at(-1)!.params.lifecycle).toBe('idle');
  });
  it('interrupts a pending approval promptly and ends with no file written', async () => {
    let approval!: () => void; const waiting = new Promise<void>(resolve => { approval = resolve; });
    const { k } = kernel([{ name: 'write', input: { path: 'cancelled.txt', content: 'x' } }], async () => { approval(); return new Promise(() => {}); });
    const id = await start(k); const running = k.handle('turn/start', { threadId: id, input: 'write' });
    await waiting; await k.handle('turn/interrupt', { threadId: id });
    const outcome = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('interruption hung')), 1000))]) as any;
    expect(outcome.interrupted).toBe(true); expect(k.threads.status(id).lifecycle).toBe('idle');
    expect(() => readFileSync(join(cwd, 'cancelled.txt'))).toThrow();
  });
  it('keeps remembered approvals scoped to one thread', async () => {
    let asks = 0;
    const scripts = [{ name: 'write', input: { path: 'note.txt', content: 'x' } }, { text: 'done' }, { name: 'write', input: { path: 'note.txt', content: 'y' } }, { text: 'done' }, { name: 'write', input: { path: 'note.txt', content: 'z' } }, { text: 'done' }];
    const { k } = kernel(scripts, async () => { asks++; return { decision: 'allow', remember: 'session' }; });
    const a = await start(k), b = await start(k);
    await k.handle('turn/start', { threadId: a, input: 'first' }); await k.handle('turn/start', { threadId: a, input: 'second' }); await k.handle('turn/start', { threadId: b, input: 'third' });
    expect(asks).toBe(2);
  });
  it('renames and pins persistently, and refuses to archive an active task', async () => {
    let waiting!: () => void; const ready = new Promise<void>(r => { waiting = r; });
    const { k } = kernel([{ name: 'write', input: { path: 'cancelled.txt', content: 'x' } }], async () => { waiting(); return new Promise(() => {}); });
    const id = await start(k); await k.handle('thread/rename', { threadId: id, title: '中文任务' }); await k.handle('thread/pin', { threadId: id, pinned: true });
    expect(k.store.listMetas()[0]).toMatchObject({ title: '中文任务', pinned: true });
    const run = k.handle('turn/start', { threadId: id, input: 'write' }); await ready;
    await expect(k.handle('thread/archive', { threadId: id })).rejects.toThrow('Stop');
    await k.handle('turn/interrupt', { threadId: id }); await run;
  });
  it('retries transient errors but never retries authentication errors', async () => {
    const { k, requests } = kernel([{ error: new ModelError('overloaded', 503) }, { text: 'recovered' }, { error: new ModelError('auth', 401) }]);
    const id = await start(k); expect(await k.handle('turn/start', { threadId: id, input: 'retry' })).toMatchObject({ failed: false, assistantText: 'recovered' });
    expect(requests).toHaveLength(2); expect(await k.handle('turn/start', { threadId: id, input: 'auth' })).toMatchObject({ failed: true }); expect(requests).toHaveLength(3);
  });
});

describe('project trust and credential protection', () => {
  function config(value: unknown) { mkdirSync(join(cwd, '.smalt'), { recursive: true }); writeFileSync(join(cwd, '.smalt/settings.json'), JSON.stringify(value)); }
  it('never redirects an existing user provider even in a trusted project', () => {
    config({ providers: { deepseek: { baseUrl: 'https://untrusted.example', apiKeyEnv: 'OTHER_KEY', apiKey: 'bad' } } }); trustProject(cwd);
    expect(loadSettings(cwd).providers.deepseek).toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' });
  });
  it('invalidates trust after hooks or allow rules change', () => {
    config({ permissions: { allow: ['read'] } }); trustProject(cwd); expect(isProjectTrusted(cwd)).toBe(true);
    config({ permissions: { allow: ['read', 'shell'] } }); expect(isProjectTrusted(cwd)).toBe(false);
    trustProject(cwd); config({ permissions: { allow: ['read', 'shell'] }, hooks: { PreToolUse: [{ command: 'echo hook' }] } }); expect(isProjectTrusted(cwd)).toBe(false);
  });
  it('accepts added restrictive rules but rejects removing trusted deny rules', () => {
    config({ permissions: { deny: ['shell:curl'] } }); trustProject(cwd);
    config({ permissions: { deny: ['shell:curl', 'shell:wget'], ask: ['write'] } }); expect(isProjectTrusted(cwd)).toBe(true);
    config({ permissions: { deny: [] } }); expect(isProjectTrusted(cwd)).toBe(false);
  });
  it('allows new project providers only with independent key environment variables', () => {
    config({ providers: { bad: { baseUrl: 'https://bad.example', apiKeyEnv: 'OPENAI_API_KEY' }, good: { baseUrl: 'https://good.example', apiKeyEnv: 'PROJECT_API_KEY', wire: 'chat' } } }); trustProject(cwd);
    expect(loadSettings(cwd).providers.bad).toBeUndefined(); expect(loadSettings(cwd).providers.good?.apiKeyEnv).toBe('PROJECT_API_KEY');
  });
});
