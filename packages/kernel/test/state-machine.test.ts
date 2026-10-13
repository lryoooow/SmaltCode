import { describe, expect, it } from 'vitest';
import { SessionRunStateMachine } from '../src/core/state-machine.js';

describe('SessionRunStateMachine', () => {
  it('walks a normal turn: prepare → request → stream → done → idle', () => {
    const sm = new SessionRunStateMachine();
    expect(sm.transition('RUN_PREPARING')).toBe(true);
    expect(sm.transition('RUN_ACCEPTED')).toBe(true);
    expect(sm.transition('MODEL_STREAM_STARTED')).toBe(true); // from model_requesting
    expect(sm.transition('MODEL_RESPONSE_DONE')).toBe(true);
    expect(sm.transition('AGENT_ENDED')).toBe(true);
    expect(sm.current).toBe('idle');
    expect(sm.lifecycle).toBe('idle');
  });

  it('supports consecutive tool calls in one turn (multi tool_calls regression)', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED'); // → model_requesting
    expect(sm.transition('TOOL_STARTED')).toBe(true); // 1st tool from model_requesting
    sm.transition('TOOL_ENDED'); // → model_requesting
    expect(sm.transition('TOOL_STARTED')).toBe(true); // 2nd tool directly
    sm.transition('WAITING_FOR_PERMISSION'); // approval prompt mid-2nd-tool
    expect(sm.lifecycle).toBe('waitingForPermission');
    sm.transition('PERMISSION_RESOLVED');
    sm.transition('TOOL_ENDED');
    expect(sm.transition('AGENT_ENDED')).toBe(true);
  });

  it('ignores invalid transitions instead of throwing', () => {
    const sm = new SessionRunStateMachine();
    expect(sm.transition('MODEL_STREAM_STARTED')).toBe(false); // idle can't stream
    expect(sm.current).toBe('idle');
  });

  it('tracks waiting for permission as a distinct lifecycle', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('TOOL_STARTED');
    sm.transition('WAITING_FOR_PERMISSION');
    expect(sm.lifecycle).toBe('waitingForPermission');
  });

  it('compaction round-trips back to running', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('MODEL_RESPONSE_DONE');
    sm.transition('COMPACT_STARTED');
    expect(sm.lifecycle).toBe('compacting');
    sm.transition('COMPACT_ENDED');
    expect(sm.lifecycle).toBe('running');
  });

  it('FORCE_IDLE always applies as defence in depth', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('MODEL_STREAM_STARTED');
    expect(sm.transition('FORCE_IDLE')).toBe(true);
    expect(sm.current).toBe('idle');
  });

  it('once cancelling, only terminal events apply', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('CANCEL_REQUESTED');
    expect(sm.current).toBe('cancelling');
    expect(sm.transition('TOOL_STARTED')).toBe(false);
    expect(sm.transition('MODEL_STREAM_STARTED')).toBe(false);
    expect(sm.transition('AGENT_ENDED')).toBe(true);
    expect(sm.current).toBe('idle');
  });

  it('records which drain-eligible event returned it to idle', () => {
    const sm = new SessionRunStateMachine();
    sm.transition('RUN_PREPARING');
    sm.transition('RUN_ACCEPTED');
    sm.transition('MODEL_RESPONSE_DONE');
    sm.transition('AGENT_ENDED');
    expect(sm.drainedBy()).toBe('AGENT_ENDED');
  });
});
