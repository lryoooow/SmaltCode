/** ClientPort implementation that talks to the human through the terminal. */

import * as readline from 'node:readline';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ClientPort,
  UserInputRequest,
} from '@smalt/kernel';
import { TerminalRenderer } from './render.js';

export interface TerminalAsker {
  (q: string, id?: string): Promise<string>;
  cancel?(id: string): void;
}

export class TerminalPort implements ClientPort {
  private readonly cancelled = new Set<string>();
  constructor(
    private readonly renderer: TerminalRenderer,
    private readonly question: TerminalAsker,
  ) {}

  notify(method: string, params?: unknown): void {
    this.renderer.handleNotification(method, params);
  }

  cancelApproval(id: string): void {
    this.cancelled.add(id);
    this.question.cancel?.(id);
  }

  cancelInput(id: string): void {
    this.cancelled.add(id);
    this.question.cancel?.(id);
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    process.stdout.write('\n');
    process.stdout.write(`┌─ ${'approval needed'.toUpperCase()}\n`);
    process.stdout.write(`│  ${req.title}\n`);
    if (req.detail) process.stdout.write(`│  ${req.detail}\n`);
    process.stdout.write(`│  tool: ${req.tool}\n`);
    try {
      for (;;) {
        if (this.cancelled.has(req.itemId)) return { decision: 'deny', reason: 'cancelled' };
        const answer = (
          await this.question('└─ allow? [y]es / [n]o / [a]lways allow > ', req.itemId)
        ).trim().toLowerCase();
        if (this.cancelled.has(req.itemId)) return { decision: 'deny', reason: 'cancelled' };
        if (answer === 'y' || answer === 'yes') {
          return { decision: 'allow' };
        }
        if (answer === 'n' || answer === 'no' || answer === '') {
          // empty input is NOT consent — a closed/non-interactive stdin must fail closed
          if (answer === '') {
            process.stdout.write('  (no input — treating as NO. Approve explicitly with y.)\n');
          }
          return { decision: 'deny', reason: 'user declined in terminal' };
        }
        if (answer === 'a' || answer === 'always') {
          return { decision: 'allow', remember: 'always' };
        }
      }
    } finally {
      this.cancelled.delete(req.itemId);
    }
  }

  async askUser(req: UserInputRequest): Promise<string> {
    process.stdout.write('\n');
    process.stdout.write(`? ${req.question}\n`);
    if (req.options?.length) {
      process.stdout.write(`  options: ${req.options.join(' | ')}\n`);
    }
    try {
      return await this.question('> ', req.itemId);
    } finally {
      this.cancelled.delete(req.itemId);
    }
  }
}

/** Serialized rl.question queue tolerating concurrent parallel tool prompts, cancellation, and closed readline. */
export function makeAsker(rl: readline.Interface): TerminalAsker {
  let closed = false;
  let active = false;
  const waiters: Array<() => void> = [];
  const activeCancels = new Map<string, () => void>();
  rl.once('close', () => { closed = true; });
  const nextInQueue = () => {
    const next = waiters.shift();
    if (next) next();
    else active = false;
  };
  const asker = ((q: string, id?: string) => new Promise<string>(resolve => {
    const start = () => {
      let done = false;
      const finish = (answer = '') => {
        if (done) return;
        done = true;
        if (id) activeCancels.delete(id);
        rl.removeListener('close', cancel);
        rl.removeListener('error', cancel);
        resolve(answer);
        nextInQueue();
      };
      const cancel = () => finish('');
      if (closed || (rl as readline.Interface & { closed?: boolean }).closed) { finish(''); return; }
      if (id) activeCancels.set(id, () => finish(''));
      rl.once('close', cancel);
      rl.once('error', cancel);
      try { rl.question(q, finish); } catch { finish(''); }
    };
    if (!active) { active = true; start(); }
    else waiters.push(start);
  })) as TerminalAsker;
  asker.cancel = (id: string) => {
    activeCancels.get(id)?.();
  };
  return asker;
}

export function installInterrupts(rl: readline.Interface, interrupt: () => void): () => void {
  rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
  const remove = () => { rl.removeListener('SIGINT', interrupt); process.removeListener('SIGINT', interrupt); };
  rl.once('close', remove); return remove;
}
