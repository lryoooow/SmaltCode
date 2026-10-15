/** Per-thread runtime state held in memory while the kernel is alive. */

import type { ChatMessage } from '../models/types.js';
import type { ModelRef } from '../config/settings.js';
import type { Item, ThreadMeta, UserPrompt } from '../protocol/types.js';
import { SessionRunStateMachine } from './state-machine.js';

export class ThreadRuntime {
  readonly stateMachine = new SessionRunStateMachine();
  /** steer messages queued while a turn is running */
  readonly steerQueue: UserPrompt[] = [];
  /** user inputs queued while a turn is running (drained when idle) */
  readonly turnQueue: UserPrompt[] = [];
  items: Item[] = [];
  history: ChatMessage[];
  abort: AbortController | null = null;
  usage = { inputTokens: 0, outputTokens: 0 };
  /** Rebuilt after settings change; never shared with another thread. */
  runner?: import('./turn-runner.js').TurnRunner;
  permissions?: import('../permissions/service.js').PermissionService;
  settingsRevision = -1;
  settingsFingerprint = '';

  constructor(
    readonly meta: ThreadMeta,
    readonly modelRef: ModelRef,
    history: ChatMessage[],
    private readonly onUsagePersisted?: (u: { inputTokens: number; outputTokens: number }) => void,
  ) {
    this.history = history;
  }

  addUsage(input: number, output: number): void {
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
  }

  snapshotUsage(): { inputTokens: number; outputTokens: number } {
    return { ...this.usage };
  }

  notifyUsagePersisted(): void {
    this.onUsagePersisted?.(this.snapshotUsage());
  }
}
