import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  ChatCompletionsAdapter,
  HookBus,
  ModelError,
  PermissionService,
  ResponsesAdapter,
  RpcError,
  SessionRunStateMachine,
  ThreadManager,
  ToolOrchestrator,
  ToolRegistry,
  applyPatch,
  budgetToolOutput,
  checkPostEditDiagnostics,
  commandAllowedBy,
  dangerousCommandCheck,
  decodeLine,
  isInsideWorkspace,
  isSensitivePath,
  loadSettings,
  parseRule,
  replayEvents,
  resolveModelRef,
  resolveWorkspacePath,
  toChatWireMessages,
  truncate,
  trustProject,
  wellFormedUtf16,
  type ChatMessage,
  type ModelDelta,
} from '../src/index.js';
import { toAnthropicWire } from '../src/models/adapters/anthropic.js';
import { ModelCatalog } from '../src/models/catalog.js';
import { parseSseEvents } from '../src/models/sse.js';
import { assessTurn } from '../src/protocol/assessment.js';
import { CheckpointStore } from '../src/storage/checkpoints.js';
import { JsonlThreadStore } from '../src/storage/jsonl.js';
import { globTool } from '../src/tools/defs/search.js';

const tempDirs: string[] = [];
function makeTempDir(prefix = 'smalt-audit-v009-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('v0.0.9 Deep Audit Regressions — Security, Boundaries & Permissions', () => {
  it('blocks NTFS Alternate Data Streams, drive-relative paths, and dangling symlink escapes', () => {
    const root = makeTempDir();
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);

    expect(isInsideWorkspace(ws, 'notes.txt:hidden')).toBe(false);
    expect(isInsideWorkspace(ws, 'notes.txt::$DATA')).toBe(false);
    if (process.platform === 'win32') {
      expect(isInsideWorkspace(ws, 'C:relative.txt')).toBe(false);
      expect(isInsideWorkspace(ws, 'trailing. ')).toBe(false);
    }

    try {
      symlinkSync(join(outside, 'nonexistent-secret.txt'), join(ws, 'dangling-link.txt'));
      expect(isInsideWorkspace(ws, join(ws, 'dangling-link.txt'))).toBe(false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }

    expect(isSensitivePath('/', '/.env')).toBe(true);
    expect(isInsideWorkspace('/', '/tmp/example')).toBe(true);
  });

  it('keeps explicit plan mode over trusted project settings, merges hooks, and preserves OpenRouter multi-segment models', () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const ws = join(root, 'ws');
    mkdirSync(join(ws, '.smalt'), { recursive: true });
    mkdirSync(home, { recursive: true });

    const prevHome = process.env.SMALT_HOME;
    process.env.SMALT_HOME = home;
    try {
      writeFileSync(
        join(home, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'openrouter',
          defaultModel: 'openai/gpt-4o-mini',
          hooks: { PreToolUse: [{ command: 'echo user-hook' }] },
        }),
      );
      writeFileSync(
        join(ws, '.smalt', 'settings.json'),
        JSON.stringify({
          permissions: { mode: 'acceptEdits' },
          hooks: { PreToolUse: [{ command: 'echo project-hook' }] },
        }),
      );
      trustProject(ws);

      const loaded = loadSettings(ws, { permissionMode: 'plan' });
      expect(loaded.permissions.mode).toBe('plan');
      expect(loaded.hooks?.PreToolUse).toHaveLength(2);

      const ref = resolveModelRef('openai/gpt-4o-mini', loaded);
      expect(ref).toEqual({ provider: 'openrouter', model: 'openai/gpt-4o-mini' });

      const store = new JsonlThreadStore(join(home, 'threads'));
      const tm = new ThreadManager({
        store,
        settings: () => loaded,
        notify: () => {},
      });
      const started = tm.start({ cwd: ws, model: 'openrouter/anthropic/claude-sonnet-4' });
      expect(started.modelRef).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });

      const tmReloaded = new ThreadManager({
        store,
        settings: () => loaded,
        notify: () => {},
      });
      const resumed = tmReloaded.resume(started.meta.id);
      expect(resumed.modelRef).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });

      if (process.platform === 'win32') {
        expect(isInsideWorkspace(ws, resolveWorkspacePath(ws, '/Users/other/secret.txt'))).toBe(false);
        expect(isInsideWorkspace(ws, resolveWorkspacePath(ws, 'src/index.ts'))).toBe(true);
      }
    } finally {
      if (prevHome === undefined) delete process.env.SMALT_HOME;
      else process.env.SMALT_HOME = prevHome;
    }
  });

  it('hardens shell rule parsing against escaped quotes, subshells, sudo/env wrappers, and .. path traversal', () => {
    expect(commandAllowedBy('echo *', 'echo "hello \\" && rm -rf /"')).toBe(false);
    expect(commandAllowedBy('echo *', '(echo ok; rm -rf /)')).toBe(false);
    expect(commandAllowedBy('echo *', 'echo @(malicious)')).toBe(false);
    expect(commandAllowedBy('echo *', 'echo ${PATH:=x}')).toBe(false);
    expect(commandAllowedBy('echo *', 'echo safe')).toBe(true);

    expect(dangerousCommandCheck('(rm -rf /)').dangerous).toBe(true);
    expect(dangerousCommandCheck('sudo env VAR=1 /bin/rm -rf /').dangerous).toBe(true);

    const root = makeTempDir();
    const perms = new PermissionService(
      [parseRule('shell:rm *', 'user')],
      [parseRule('write:src/**', 'user'), parseRule('ssh_exec:ls *', 'user')],
      [],
    );
    expect(perms.check({ tool: 'write', input: { path: 'src/../package.json' }, subject: 'src/../package.json', cwd: root }).action).toBe('ask');
    expect(perms.check({ tool: 'write', input: { path: 'src/app.ts' }, subject: 'src/app.ts', cwd: root }).action).toBe('allow');
    expect(perms.check({ tool: 'shell', input: { command: 'sudo rm -rf build' }, subject: 'sudo rm -rf build', cwd: root }).action).toBe('deny');
    expect(perms.check({ tool: 'ssh_exec', input: { command: 'ls -la' }, subject: 'ls -la', cwd: root }).action).toBe('allow');
    expect(perms.check({ tool: 'ssh_exec', input: { command: 'uname -a' }, subject: 'uname -a', cwd: root }).action).toBe('ask');
  });

  it('enforces smaltHome shell boundary, preserves explicit ask rules over PreToolUse allow, and scopes Always-Allow safely', async () => {
    const root = makeTempDir();
    const home = join(root, 'smalt-data');
    const ws = join(root, 'ws');
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'sample.ts'), 'export const hello = 42;\n');

    const prevHome = process.env.SMALT_HOME;
    process.env.SMALT_HOME = home;
    try {
      const hooks = new HookBus();
      hooks.register((ev) => (ev === 'PreToolUse' ? { decision: 'allow' } : undefined));

      const perms = new PermissionService([], [], [parseRule('grep', 'user'), parseRule('shell:node *', 'user')]);
      const remembered: string[] = [];
      let approvals = 0;
      const orchestrator = new ToolOrchestrator({
        tools: new ToolRegistry(),
        permissions: perms,
        hooks,
        requestApproval: async () => {
          approvals++;
          return { decision: 'allow', remember: 'always' };
        },
        onRememberAlways: (rule) => remembered.push(rule),
        askUser: async () => '',
        log: () => {},
      });

      const ctx = { cwd: ws, threadId: 'th_1', turnId: 't_1', itemId: 'i_1', signal: new AbortController().signal, log: () => {} };

      // Shell referencing smaltHome must be blocked as boundary violation
      const leakAttempt = await orchestrator.execute('c_leak', 'shell', { command: `cat "${home}/settings.json"` }, ctx);
      expect(leakAttempt.denied).toBe(true);

      // Explicit ask rule on grep must NOT be bypassed by PreToolUse allow, and once approved must NOT drop grep matches!
      const grepRes = await orchestrator.execute('c_grep', 'grep', { pattern: 'hello' }, ctx);
      expect(approvals).toBe(1);
      expect(grepRes.isError).toBe(false);
      expect(grepRes.output).toContain('sample.ts');

      // Interpreter -e command must NOT save broad "shell:node *" wildcard
      await orchestrator.execute('c_node', 'shell', { command: 'node -e "console.log(123)"' }, ctx);
      expect(remembered).not.toContain('shell:node *');
      expect(remembered).toContain('shell:node -e "console.log(123)"');
    } finally {
      if (prevHome === undefined) delete process.env.SMALT_HOME;
      else process.env.SMALT_HOME = prevHome;
    }
  });
});

describe('v0.0.9 Deep Audit Regressions — Model Adapters, SSE, UTF-16 & Tools', () => {
  it('throws AbortError on aborted SSE streams, flushes final newline-less chunks, and sanitizes lone UTF-16 surrogates', async () => {
    const encoder = new TextEncoder();
    const trailingBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"hello":1}'));
        c.close();
      },
    });
    const events: string[] = [];
    for await (const ev of parseSseEvents(trailingBody)) events.push(ev.data);
    expect(events).toEqual(['{"hello":1}']);

    const ac = new AbortController();
    ac.abort();
    const abortedBody = new ReadableStream<Uint8Array>({ start() {} });
    await expect(async () => {
      for await (const _ of parseSseEvents(abortedBody, ac.signal)) { /* unreachable */ }
    }).rejects.toMatchObject({ name: 'AbortError' });

    const emoji = 'prefix😀suffix'; // 😀 is at indices 6..7
    const sliced = truncate(emoji, 7, '');
    expect(sliced).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(wellFormedUtf16('\uD83Dbad\uDE00')).toBe('\uFFFDbad\uFFFD');
    expect(() => JSON.stringify(budgetToolOutput('😀'.repeat(5000), 101))).not.toThrow();
  });

  it('captures Anthropic signed thinking blocks, scales max_tokens, and rejects truncated Anthropic/Responses streams', async () => {
    let sentBody: any;
    const ssePayload = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 1"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      '',
    ].join('\n\n');

    const anthropic = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      fetchImpl: (async (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return new Response(ssePayload);
      }) as typeof fetch,
    });

    const deltas: ModelDelta[] = [];
    for await (const d of anthropic.stream({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'check' }],
      tools: [],
      reasoningEffort: 'max',
    })) {
      deltas.push(d);
    }
    expect(sentBody.max_tokens).toBe(24576);
    expect(sentBody.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    const tb = deltas.find((d) => d.type === 'thinkingBlock');
    expect(tb).toEqual({ type: 'thinkingBlock', block: { type: 'thinking', thinking: 'Step 1', signature: 'sig_xyz' } });

    const wireWithThinking = toAnthropicWire(
      [
        { role: 'user', content: 'check' },
        {
          role: 'assistant',
          content: null,
          thinkingBlocks: [{ type: 'thinking', thinking: 'Step 1', signature: 'sig_xyz' }],
          toolCalls: [{ id: 'tu_1', name: 'read', arguments: '{"path":"a.ts"}' }],
        },
        { role: 'tool', toolCallId: 'tu_1', content: 'ok' },
      ],
      true,
    );
    expect((wireWithThinking.messages[1] as any).content[0]).toEqual({
      type: 'thinking',
      thinking: 'Step 1',
      signature: 'sig_xyz',
    });

    // Premature Anthropic EOF without message_stop MUST throw ModelError
    const truncatedAnthropic = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      fetchImpl: (async () => new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n')) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of truncatedAnthropic.stream({ model: 'claude', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* consume */ }
    }).rejects.toThrow(ModelError);

    // Premature Responses EOF mid-tool-call without response.completed MUST throw ModelError
    const truncatedResponses = new ResponsesAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(
          'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"c_1","name":"write"}}\n\n',
        )) as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of truncatedResponses.stream({ model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* consume */ }
    }).rejects.toThrow(/before response\.completed/);
  });

  it('handles empty-string tool_call id and active-turn empty reasoning_content in ChatCompletionsAdapter, and preserves preferredWire in ModelCatalog', async () => {
    const chat = new ChatCompletionsAdapter({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"read","arguments":"{\\"path\\":\\"x.ts\\"}"}}]}}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
        )) as typeof fetch,
    });
    const out: ModelDelta[] = [];
    for await (const d of chat.stream({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], tools: [] })) {
      out.push(d);
    }
    const start = out.find((d) => d.type === 'toolCallStart') as Extract<ModelDelta, { type: 'toolCallStart' }>;
    expect(start.id).toBe('call_0');

    const wire = toChatWireMessages(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', content: 'done' },
      ],
      true,
    ) as any[];
    expect(wire[1].reasoning_content).toBe('');

    const dir = makeTempDir();
    const cacheFile = join(dir, 'catalog.json');
    const catalog1 = new ModelCatalog({
      file: cacheFile,
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-5.3-codex' }] }))) as typeof fetch,
    });
    const oaCfg = { baseUrl: 'https://api.openai.com/v1', wire: 'chat' as const, apiKey: 'sk-test', defaultModel: 'gpt-5.3-codex' };
    await catalog1.refresh(oaCfg, true);
    const catalog2 = new ModelCatalog({ file: cacheFile });
    expect(catalog2.snapshot(oaCfg).models.find((m) => m.id === 'gpt-5.3-codex')?.preferredWire).toBe('responses');
  });

  it('honors @@ anchors in apply_patch, avoids false-positive diagnostics, skips >2MB checkpoints cleanly, and supports {a,b} in glob', async () => {
    const ws = makeTempDir();
    writeFileSync(
      join(ws, 'dup.ts'),
      [
        'class Alpha {',
        '  run() {',
        '    return 1;',
        '  }',
        '}',
        '',
        'class Beta {',
        '  run() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const report = applyPatch(
      [
        '*** Begin Patch',
        '*** Update File: dup.ts',
        '@@ class Beta',
        '   run() {',
        '-    return 1;',
        '+    return 2;',
        '   }',
        '*** End Patch',
      ].join('\n'),
      ws,
    );
    expect(report.changes).toHaveLength(1);
    const updated = readFileSync(join(ws, 'dup.ts'), 'utf8');
    expect(updated).toContain('class Alpha {\n  run() {\n    return 1;');
    expect(updated).toContain('class Beta {\n  run() {\n    return 2;');

    // Diagnostics: standalone ======= banner & return /regex/ & TSX text must NOT trigger false positives
    writeFileSync(join(ws, 'banner.ts'), '// =======\nexport function f(s: string) {\n  return /abc(def/.test(s);\n}\n');
    expect(checkPostEditDiagnostics(join(ws, 'banner.ts'), 'banner.ts')).toBeNull();
    writeFileSync(join(ws, 'View.tsx'), 'export const View = () => <div>Price > 0)</div>;\n');
    expect(checkPostEditDiagnostics(join(ws, 'View.tsx'), 'View.tsx')).toBeNull();
    writeFileSync(join(ws, 'conflict.ts'), '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> branch\n');
    expect(checkPostEditDiagnostics(join(ws, 'conflict.ts'), 'conflict.ts')).toContain('unresolved merge conflict');

    // CheckpointStore: >2MB file skipped gracefully without throwing
    const cpStore = new CheckpointStore(join(ws, '.cp'));
    const bigPath = join(ws, 'large.bin');
    writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61));
    const cp = await cpStore.capture('th1', 'turn1', ws, 'edit large', ['large.bin', 'banner.ts']);
    writeFileSync(join(ws, 'banner.ts'), '// updated\n');
    await expect(cpStore.complete(cp)).resolves.toBeUndefined();
    const listed = await cpStore.list('th1', ws);
    expect(listed[0]?.files.map((f) => f.path)).toEqual(['banner.ts']);

    // Glob {ts,tsx} brace expansion
    const globEvents = [];
    for await (const ev of globTool.run({ pattern: '*.{ts,tsx}' }, { cwd: ws, threadId: 'th1', turnId: 't1', itemId: 'i1', signal: new AbortController().signal, log: () => {} })) {
      globEvents.push(ev);
    }
    expect((globEvents[0] as any).text).toContain('View.tsx');
    expect((globEvents[0] as any).text).toContain('dup.ts');
  });

  it('ref-counts parallel permission states, stops mid-turn fork cleanly, folds resource_read retries, and guards JSON-RPC null error', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('TOOL_STARTED');
    sm.transition('WAITING_FOR_PERMISSION');
    sm.transition('WAITING_FOR_PERMISSION');
    expect(sm.lifecycle).toBe('waitingForPermission');
    sm.transition('PERMISSION_RESOLVED');
    expect(sm.lifecycle).toBe('waitingForPermission');
    sm.transition('PERMISSION_RESOLVED');
    expect(sm.lifecycle).toBe('running');

    // JSON-RPC error:null throws RpcError instead of TypeError
    expect(() => decodeLine('{"jsonrpc":"2.0","id":1,"error":null}')).toThrow(RpcError);

    // replayEvents resets stale reasoning across interrupted turn boundaries
    const replayed = replayEvents([
      { t: 'turn-started', turnId: 't1', at: '2026-11-16T00:00:00Z' },
      { t: 'user-msg', id: 'u1', text: 'q1', at: '2026-11-16T00:00:00Z' },
      { t: 'reasoning', id: 'r1', text: 'aborted thought', at: '2026-11-16T00:00:01Z' },
      { t: 'turn-ended', turnId: 't1', interrupted: true, at: '2026-11-16T00:00:02Z' },
      { t: 'turn-started', turnId: 't2', at: '2026-11-16T00:00:03Z' },
      { t: 'user-msg', id: 'u2', text: 'q2', at: '2026-11-16T00:00:03Z' },
      { t: 'agent-msg', id: 'a2', text: 'clean answer', at: '2026-11-16T00:00:04Z' },
    ]);
    const lastAssistant = replayed.history.at(-1) as Extract<ChatMessage, { role: 'assistant' }>;
    expect(lastAssistant.reasoningContent).toBeUndefined();

    // assessTurn folds superseded resource_read retry
    const turnAssessment = assessTurn(
      [
        { id: 'c1', threadId: 'th', turnId: 't1', createdAt: '', status: 'failed', kind: 'commandExecution', tool: 'resource_read', command: 'resource_read README.md', output: 'limit: unknown parameter', exitCode: 1 },
        { id: 'c2', threadId: 'th', turnId: 't1', createdAt: '', status: 'completed', kind: 'commandExecution', tool: 'resource_read', command: 'resource_read README.md', output: '{"content":"ok"}', exitCode: 0 },
      ],
      '浏览项目',
    );
    expect(turnAssessment.status).toBe('completed');
    expect(turnAssessment.recovered).toBe(1);
  });
});
