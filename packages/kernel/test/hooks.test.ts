import { describe, expect, it } from 'vitest';
import { HookBus } from '../src/hooks/bus.js';

describe('HookBus merge policy', () => {
  it('treats nonzero command-hook exits as failures instead of permitting silently', async () => {
    const bus = new HookBus(); bus.setCommandHooks({ PreToolUse: [{ command: 'exit 7' }] });
    expect(await bus.emit('PreToolUse', {})).toMatchObject({ decision: 'ask', anyFailed: true });
  });
  it('supplies thread and workspace context to forked hooks', async () => {
    const parent = new HookBus(); let received: unknown;
    parent.register((_event, payload) => { received = payload; });
    await parent.fork({}, { cwd: '/workspace', threadId: 'thread' }).emit('PreToolUse', { tool: 'read' });
    expect(received).toMatchObject({ cwd: '/workspace', threadId: 'thread', tool: 'read' });
  });
  it('a later allow cannot override an earlier deny (strictest wins)', async () => {
    const bus = new HookBus();
    bus.register(async () => ({ decision: 'deny', reason: 'nope' }), 'guard-1');
    bus.register(async () => ({ decision: 'allow' }), 'guard-2');
    const result = await bus.emit('PreToolUse', { tool: 'shell', input: {} });
    expect(result?.decision).toBe('deny');
    expect(result?.reason).toBe('nope');
  });

  it('ask beats allow', async () => {
    const bus = new HookBus();
    bus.register(async () => ({ decision: 'ask', reason: 'check' }), 'a');
    bus.register(async () => ({ decision: 'allow' }), 'b');
    expect((await bus.emit('PreToolUse', { tool: 'shell' }))?.decision).toBe('ask');
  });

  it('a crashed in-process hook degrades to ask with anyFailed', async () => {
    const bus = new HookBus();
    bus.register(async () => {
      throw new Error('boom');
    }, 'broken');
    const result = await bus.emit('PreToolUse', { tool: 'shell' });
    expect(result?.anyFailed).toBe(true);
    expect(result?.decision).toBe('ask');
  });

  it('an allow decision plus a crashed hook still reports anyFailed', async () => {
    const bus = new HookBus();
    bus.register(async () => ({ decision: 'allow' }), 'ok');
    bus.register(async () => {
      throw new Error('bang');
    }, 'bad');
    const result = await bus.emit('PreToolUse', { tool: 'shell' });
    // allow is kept, but callers must see anyFailed and fail closed
    expect(result?.decision).toBe('allow');
    expect(result?.anyFailed).toBe(true);
  });

  it('modifiedInput from a later hook survives a deny merge', async () => {
    const bus = new HookBus();
    bus.register(async () => ({ decision: 'deny', reason: 'first' }), 'd');
    bus.register(async () => ({ decision: 'allow', modifiedInput: { command: 'ls' } }), 'r');
    const result = await bus.emit('PreToolUse', { tool: 'shell' });
    expect(result?.decision).toBe('deny');
    expect(result?.modifiedInput).toEqual({ command: 'ls' });
  });

  it('events with no decisions resolve to null', async () => {
    const bus = new HookBus();
    bus.register(async () => undefined, 'observer');
    expect(await bus.emit('PostToolUse', { tool: 'read' })).toBeNull();
  });
});
