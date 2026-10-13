/** ClientPort implementation that talks to the human through the terminal. */

import * as readline from 'node:readline';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ClientPort,
  UserInputRequest,
} from '@smalt/kernel';
import { TerminalRenderer } from './render.js';

export class TerminalPort implements ClientPort {
  constructor(
    private readonly renderer: TerminalRenderer,
    private readonly question: (q: string) => Promise<string>,
  ) {}

  notify(method: string, params?: unknown): void {
    this.renderer.handleNotification(method, params);
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    process.stdout.write('\n');
    process.stdout.write(`┌─ ${'approval needed'.toUpperCase()}\n`);
    process.stdout.write(`│  ${req.title}\n`);
    if (req.detail) process.stdout.write(`│  ${req.detail}\n`);
    process.stdout.write(`│  tool: ${req.tool}\n`);
    for (;;) {
      const answer = (
        await this.question('└─ allow? [y]es / [n]o / [a]lways allow > ')
      ).trim().toLowerCase();
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
  }

  async askUser(req: UserInputRequest): Promise<string> {
    process.stdout.write('\n');
    process.stdout.write(`? ${req.question}\n`);
    if (req.options?.length) {
      process.stdout.write(`  options: ${req.options.join(' | ')}\n`);
    }
    return this.question('> ');
  }
}

/** rl.question as a promise, tolerating a closed readline. */
export function makeAsker(rl: readline.Interface): (q: string) => Promise<string> {
  return (q: string) =>
    new Promise<string>((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });
}
