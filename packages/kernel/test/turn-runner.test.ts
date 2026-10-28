import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnRunner } from '../src/core/turn-runner.js';
import { SessionRunStateMachine } from '../src/core/state-machine.js';
import { ThreadRuntime } from '../src/core/thread.js';
import { ContextPipeline, envInterceptor, systemInterceptor } from '../src/context/pipeline.js';
import { Compactor } from '../src/compact/compactor.js';
import { HookBus } from '../src/hooks/bus.js';
import { JsonlThreadStore } from '../src/storage/jsonl.js';
import { ToolOrchestrator } from '../src/tools/orchestrator.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { PermissionService } from '../src/permissions/service.js';
import type { ModelDelta, ModelStreamer } from '../src/models/types.js';
import type { ApprovalDecision, ApprovalRequest, UserInputRequest } from '../src/protocol/types.js';

/* ------------------------------------------------------------------ */

/** ModelStreamer fake serving scripted responses, one per sampling call. */
class ScriptedStreamer implements ModelStreamer {
  readonly requests: Array<{ messages: unknown[]; tools: string[] }> = [];
  private next = 0;

  constructor(private readonly scripts: ModelDelta[][]) {}

  async *stream(_ref: { provider: string; model: string }, req: Omit<import('../src/models/types.js').ModelRequest, 'model'>) {
    this.requests.push({ messages: req.messages, tools: req.tools.map((t) => t.name) });
    const script = this.scripts[Math.min(this.next, this.scripts.length - 1)] ?? [];
    this.next++;
    yield* script;
  }
}

function text(t: string): ModelDelta[] {
  return [
    { type: 'text', text: t },
    { type: 'done', finishReason: 'stop' },
  ];
}

function toolCalls(...calls: Array<{ id: string; name: string; args: unknown }>): ModelDelta[] {
  const out: ModelDelta[] = [];
  for (const c of calls) {
    out.push({ type: 'toolCallStart', id: c.id, name: c.name });
    out.push({ type: 'toolCallDelta', id: c.id, argsDelta: JSON.stringify(c.args) });
  }
  out.push({ type: 'done', finishReason: 'toolCalls' });
  return out;
}

/* ------------------------------------------------------------------ */

let cwd: string;
let store: JsonlThreadStore;
let hooks: HookBus;
let tools: ToolRegistry;
let permissions: PermissionService;
const approvals: ApprovalRequest[] = [];
let approvalResponses: ApprovalDecision[] = [];

function build(streamer: ModelStreamer) {
  const orchestrator = new ToolOrchestrator({
    tools,
    permissions,
    hooks,
    requestApproval: async (req) => {
      approvals.push(req);
      return approvalResponses.shift() ?? { decision: 'allow' };
    },
    askUser: async (_req: UserInputRequest) => 'yes',
    log: () => {},
  });
  const runner = new TurnRunner({
    gateway: streamer,
    tools,
    orchestrator,
    hooks,
    compactor: new Compactor(streamer, hooks, {
      enabled: true,
      threshold: 0.8,
      keepMessages: 10,
      maxConsecutive: 2,
      contextWindow: 1_000_000,
    }),
    pipeline: new ContextPipeline([envInterceptor(() => new Date('2026-10-12T00:00:00Z')), systemInterceptor()]),
    store,
    notify: () => {},
    log: () => {},
  });
  return runner;
}

function runtime() {
  const sm = new SessionRunStateMachine();
  const rt = new ThreadRuntime(
    {
      id: 'th_t1',
      title: 't',
      model: 'fake-model',
      provider: 'fake',
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turnCount: 0,
    },
    { provider: 'fake', model: 'fake-model' },
    [],
  );
  const adapter = {
    threadId: rt.meta.id,
    cwd: rt.meta.cwd,
    modelRef: rt.modelRef,
    history: rt.history,
    items: rt.items,
    steerQueue: rt.steerQueue,
    signal: new AbortController().signal,
    onHistoryReplaced: (h: typeof rt.history) => {
      rt.history.length = 0;
      rt.history.push(...h);
    },
    addUsage: (i: number, o: number) => rt.addUsage(i, o),
    usageTotals: () => rt.snapshotUsage(),
    contextWindow: () => 1_000_000,
  };
  return { sm, rt, adapter };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'smalt-turn-'));
  store = new JsonlThreadStore(join(cwd, '.store'));
  hooks = new HookBus(() => {});
  tools = new ToolRegistry();
  permissions = new PermissionService([], [], []);
  approvals.length = 0;
  approvalResponses = [];
});

/* ------------------------------------------------------------------ */

describe('TurnRunner', () => {
  it('keeps web guidance aligned with the tools actually available at each model step', async () => {
    let enabled = false;
    tools.register({ name: 'read', description: 'fixture', inputSchema: { type: 'object' }, subject: () => 'fixture.txt', summarize: () => 'read fixture', async *run() { enabled = true; yield { type: 'result', text: 'host enabled search' }; } });
    tools.register({ name: 'web_search', description: 'fixture', inputSchema: { type: 'object' }, available: () => enabled, subject: () => 'fixture query', summarize: () => 'search fixture', async *run() { enabled = false; yield { type: 'result', text: 'external evidence: https://example.com/source' }; } });
    const streamer = new ScriptedStreamer([
      toolCalls({ id: 'read', name: 'read', args: {} }),
      toolCalls({ id: 'web', name: 'web_search', args: {} }),
      text('Evidence received'),
    ]);
    const { sm, adapter } = runtime();
    expect((await build(streamer).runTurn(sm, adapter, 'research')).failed).toBe(false);
    expect(streamer.requests.map(request => request.tools.includes('web_search'))).toEqual([false, true, false]);
    const systems = streamer.requests.map(request => request.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n'));
    expect(systems[0]).toContain('No web search service is currently available');
    expect(systems[1]).toContain('Cite the original source URLs');
    expect(systems[1]).not.toContain('No web search service is currently available');
    expect(systems[2]).toContain('No web search service is currently available');
  });
  it('completes a plain text turn', async () => {
    const streamer = new ScriptedStreamer([text('Hello!')]);
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'hi');
    expect(outcome.assistantText).toBe('Hello!');
    expect(outcome.interrupted).toBe(false);
    expect(outcome.failed).toBe(false);
    expect(sm.current).toBe('idle');
    expect(streamer.requests[0]!.tools).toContain('read');
    expect(String(streamer.requests[0]!.messages[0]!.role === 'system' ? (streamer.requests[0]!.messages[0] as { content: string }).content : '')).toContain('smalt');
  });

  it('runs a read tool (read-only, auto-approved) and feeds the result back', async () => {
    writeFileSync(join(cwd, 'note.txt'), 'line-one\nline-two\n');
    const streamer = new ScriptedStreamer([
      toolCalls({ id: 'c1', name: 'read', args: { path: 'note.txt' } }),
      text('The file says line-one'),
    ]);
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'read the note');
    expect(outcome.assistantText).toBe('The file says line-one');
    expect(approvals).toHaveLength(0); // reads never prompt
    const toolResults = rt.history.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(1);
    expect(String(toolResults[0]!.content)).toContain('line-one');
    expect(store.load(rt.meta.id)!.some((e) => e.t === 'tool-result')).toBe(true);
  });

  it('asks for approval on shell and executes when allowed', async () => {
    const streamer = new ScriptedStreamer([
      toolCalls({ id: 'c1', name: 'shell', args: { command: 'echo smalt-works' } }),
      text('done'),
    ]);
    approvalResponses = [{ decision: 'allow' }];
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'run echo');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.tool).toBe('shell');
    const toolResult = rt.history.find((m) => m.role === 'tool');
    expect(String(toolResult!.content)).toContain('smalt-works');
    expect(outcome.assistantText).toBe('done');
  });

  it('a denial becomes a tool result, not a crash — the model continues', async () => {
    const streamer = new ScriptedStreamer([
      toolCalls({ id: 'c1', name: 'shell', args: { command: 'rm -rf /definitely/not/real' } }),
      text('okay, I will not do that'),
    ]);
    approvalResponses = [{ decision: 'deny', reason: 'nope' }];
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'delete stuff');
    expect(outcome.failed).toBe(false);
    const toolResult = rt.history.find((m) => m.role === 'tool');
    expect(String(toolResult!.content)).toContain('denied');
    expect(outcome.assistantText).toBe('okay, I will not do that');
  });

  it('executes MULTIPLE tool calls from one model response (regression)', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'AAA');
    writeFileSync(join(cwd, 'b.txt'), 'BBB');
    const streamer = new ScriptedStreamer([
      toolCalls(
        { id: 'c1', name: 'read', args: { path: 'a.txt' } },
        { id: 'c2', name: 'read', args: { path: 'b.txt' } },
      ),
      text('both files read'),
    ]);
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'read both');
    const toolResults = rt.history.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(sm.current).toBe('idle');
    expect(outcome.failed).toBe(false);
    expect(outcome.assistantText).toBe('both files read');
  });

  it('reports interruptions as interrupted, not completed normally', async () => {
    const streamer = new ScriptedStreamer([
      // first call never finishes — we abort mid-stream
      [
        { type: 'text', text: 'partial' },
        // no done delta; the generator below hangs until aborted
      ],
    ]);
    const originalStream = streamer.stream.bind(streamer);
    streamer.stream = async function* (ref, req) {
      // a stream that yields one delta, then hangs — like a stuck model request
      const aborted = new Promise<never>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      const iter = originalStream(ref, req);
      const first = await iter.next();
      if (!first.done) yield first.value;
      await Promise.race([
        aborted,
        new Promise((resolve) => setTimeout(resolve, 10_000)), // safety net
      ]);
    };
    const { sm, rt, adapter } = runtime();
    const abort = new AbortController();
    adapter.signal = abort.signal;
    const runP = build(streamer).runTurn(sm, adapter, 'slow');
    setTimeout(() => abort.abort(), 50);
    const outcome = await runP;
    expect(outcome.interrupted).toBe(true);
    expect(outcome.failed).toBe(false);
    expect(sm.current).toBe('idle');
  });

  it('folds steering messages into the next sampling step', async () => {
    const streamer = new ScriptedStreamer([
      toolCalls({ id: 'c1', name: 'read', args: { path: 'x.txt' } }),
      text('done with first pass'),
    ]);
    const { sm, rt, adapter } = runtime();
    // pre-seed the steer queue as if the user typed mid-turn
    rt.steerQueue.push('also check y.txt');
    const outcome = await build(streamer).runTurn(sm, adapter, 'check x');
    // second sampling call must contain the steer message
    const second = streamer.requests[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(second.some((m) => m.role === 'user' && String(m.content).includes('also check y.txt'))).toBe(true);
    expect(outcome.assistantText).toBe('done with first pass');
  });

  it('a blocking Stop hook keeps the turn alive exactly once', async () => {
    const unregister = hooks.register(async (event) => {
      if (event === 'Stop') {
        return { decision: 'deny', reason: 'tests are not green yet' };
      }
      return undefined;
    }, 'goal-guard');
    const streamer = new ScriptedStreamer([
      text('I think I am done'),
      text('Okay, continuing after the reminder'),
    ]);
    const { sm, rt, adapter } = runtime();
    const outcome = await build(streamer).runTurn(sm, adapter, 'make tests pass');
    expect(streamer.requests).toHaveLength(2);
    expect(rt.history.some((m) => m.role === 'user' && String(m.content).includes('Stop blocked'))).toBe(true);
    expect(outcome.assistantText).toContain('continuing after the reminder');
    unregister();
  });

  it('records cumulative usage and persists turn boundaries', async () => {
    const streamer = new ScriptedStreamer([[
      { type: 'text', text: 'counting' },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', finishReason: 'stop' },
    ]]);
    const { sm, rt, adapter } = runtime();
    await build(streamer).runTurn(sm, adapter, 'hi');
    expect(rt.snapshotUsage()).toEqual({ inputTokens: 10, outputTokens: 5 });
    const events = store.load(rt.meta.id)!;
    expect(events.some((e) => e.t === 'turn-started')).toBe(true);
    expect(events.some((e) => e.t === 'turn-ended')).toBe(true);
    expect(events.some((e) => e.t === 'usage')).toBe(true);
  });
});
