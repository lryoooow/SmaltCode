/**
 * Explicit run-state machine for a thread session.
 *
 * Fine-grained states are what kernel code transitions through; a derived
 * coarse lifecycle is what UIs and the protocol surface. Run state is *never*
 * tracked with scattered booleans — every async branch goes through
 * `transition(event)` so the whole shape stays auditable and testable.
 */

import type { ThreadRunLifecycle } from '../protocol/types.js';

export type RunState =
  | 'idle'
  | 'preparing'
  | 'model_requesting'
  | 'model_streaming'
  | 'model_done'
  | 'tool_executing'
  | 'waiting_for_permission'
  | 'waiting_for_user'
  | 'retrying'
  | 'compacting'
  | 'cancelling';

export type RunEvent =
  | 'RUN_PREPARING'
  | 'RUN_ACCEPTED'
  | 'RUN_SKIPPED'
  | 'MODEL_REQUEST_STARTED'
  | 'MODEL_STREAM_STARTED'
  | 'MODEL_RESPONSE_DONE'
  | 'TOOL_STARTED'
  | 'TOOL_ENDED'
  | 'WAITING_FOR_PERMISSION'
  | 'PERMISSION_RESOLVED'
  | 'WAITING_FOR_USER'
  | 'USER_INPUT_RESOLVED'
  | 'RETRYING'
  | 'COMPACT_STARTED'
  | 'COMPACT_ENDED'
  | 'COMPACT_FAILED'
  | 'CANCEL_REQUESTED'
  | 'AGENT_STARTED'
  | 'AGENT_ENDED'
  | 'RUN_FAILED'
  | 'FORCE_IDLE';

interface Rule {
  from: RunState[];
  to: RunState;
}

/**
 * transition table: event → (allowed source states → target state).
 * Events not listed for the current state are ignored (guarded no-ops), except
 * that FORCE_IDLE and CANCEL always apply — safety overrides.
 */
const RULES: Record<RunEvent, Rule> = {
  RUN_PREPARING: { from: ['idle'], to: 'preparing' },
  RUN_ACCEPTED: { from: ['preparing'], to: 'model_requesting' },
  RUN_SKIPPED: { from: ['preparing'], to: 'idle' },
  MODEL_REQUEST_STARTED: { from: ['tool_executing', 'model_done', 'waiting_for_user', 'retrying', 'model_requesting'], to: 'model_requesting' },
  MODEL_STREAM_STARTED: { from: ['model_requesting'], to: 'model_streaming' },
  MODEL_RESPONSE_DONE: { from: ['model_streaming', 'model_requesting'], to: 'model_done' },
  TOOL_STARTED: { from: ['model_done', 'model_requesting', 'tool_executing'], to: 'tool_executing' },
  TOOL_ENDED: { from: ['tool_executing'], to: 'model_requesting' },
  WAITING_FOR_PERMISSION: { from: ['tool_executing'], to: 'waiting_for_permission' },
  PERMISSION_RESOLVED: { from: ['waiting_for_permission'], to: 'tool_executing' },
  WAITING_FOR_USER: { from: ['model_done', 'tool_executing'], to: 'waiting_for_user' },
  USER_INPUT_RESOLVED: { from: ['waiting_for_user'], to: 'tool_executing' },
  RETRYING: { from: ['model_done', 'model_streaming', 'model_requesting'], to: 'retrying' },
  COMPACT_STARTED: { from: ['idle', 'model_done', 'preparing', 'model_requesting'], to: 'compacting' },
  COMPACT_ENDED: { from: ['compacting'], to: 'model_requesting' },
  COMPACT_FAILED: { from: ['compacting'], to: 'idle' },
  CANCEL_REQUESTED: { from: ['preparing', 'model_requesting', 'model_streaming', 'model_done', 'tool_executing', 'waiting_for_permission', 'waiting_for_user', 'retrying', 'compacting'], to: 'cancelling' },
  AGENT_STARTED: { from: ['idle'], to: 'preparing' },
  AGENT_ENDED: { from: ['model_done', 'waiting_for_user', 'waiting_for_permission', 'cancelling', 'tool_executing', 'model_streaming', 'model_requesting'], to: 'idle' },
  RUN_FAILED: { from: ['preparing', 'model_requesting', 'model_streaming', 'model_done', 'tool_executing', 'waiting_for_permission', 'waiting_for_user', 'retrying', 'compacting', 'cancelling'], to: 'idle' },
  FORCE_IDLE: { from: ['idle', 'preparing', 'model_requesting', 'model_streaming', 'model_done', 'tool_executing', 'waiting_for_permission', 'waiting_for_user', 'retrying', 'compacting', 'cancelling'], to: 'idle' },
};

/**
 * Events whose arrival back at `idle` qualifies the session for draining its
 * queued user messages (starting the next turn automatically).
 */
export const DRAIN_ELIGIBLE_IDLE_EVENTS: readonly RunEvent[] = [
  'AGENT_ENDED',
  'RUN_FAILED',
  'COMPACT_FAILED',
  'FORCE_IDLE',
];

const LIFECYCLE_OF: Record<RunState, ThreadRunLifecycle> = {
  idle: 'idle',
  preparing: 'preparing',
  model_requesting: 'running',
  model_streaming: 'running',
  model_done: 'running',
  tool_executing: 'running',
  waiting_for_permission: 'waitingForPermission',
  waiting_for_user: 'waitingForUser',
  retrying: 'retrying',
  compacting: 'compacting',
  cancelling: 'cancelling',
};

export class SessionRunStateMachine {
  private state: RunState = 'idle';
  private lastIdleEvent: RunEvent | null = null;
  onChange?: () => void;

  get current(): RunState {
    return this.state;
  }

  get lifecycle(): ThreadRunLifecycle {
    return LIFECYCLE_OF[this.state];
  }

  isIdle(): boolean {
    return this.state === 'idle';
  }

  isRunning(): boolean {
    return this.state !== 'idle';
  }

  /**
   * Apply an event. Returns true when the transition changed the state.
   * Invalid transitions are ignored unless the event is FORCE_IDLE (defence in
   * depth: a stale async branch can always return the machine to rest).
   * Once `cancelling`, only AGENT_ENDED / RUN_FAILED / FORCE_IDLE apply — the
   * RULES table encodes this by not listing `cancelling` elsewhere.
   */
  transition(event: RunEvent): boolean {
    const rule = RULES[event];
    if (!rule.from.includes(this.state)) {
      return false;
    }
    this.state = rule.to;
    if (this.state === 'idle') this.lastIdleEvent = event;
    this.onChange?.();
    return true;
  }

  /** Which event brought the machine back to idle (for drain decisions). */
  drainedBy(): RunEvent | null {
    return this.isIdle() ? this.lastIdleEvent : null;
  }
}
