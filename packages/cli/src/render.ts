/** Terminal rendering for kernel notifications. Pure ANSI, zero deps. */

import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  Item,
  PlanItem,
  ThreadStatus,
  ThreadTokenUsage,
} from '@smalt/kernel';

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (supportsColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const yellow = (s: string) => c('33', s);
const green = (s: string) => c('32', s);
const red = (s: string) => c('31', s);
const blue = (s: string) => c('34', s);

export class TerminalRenderer {
  private inStream = false;
  private lastPlan: PlanItem | null = null;

  handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/agentMessage/delta':
        this.beginStream();
        process.stdout.write(String(p.delta ?? ''));
        break;
      case 'item/reasoning/textDelta': {
        // reasoning is shown dimly, inline before the answer
        this.beginStream();
        if (supportsColor) process.stdout.write(dim(String(p.delta ?? '')));
        else process.stdout.write(String(p.delta ?? ''));
        break;
      }
      case 'item/completed':
        this.endStream();
        this.renderItem(p.item as Item);
        break;
      case 'turn/started':
        this.lastPlan = null;
        break;
      case 'turn/completed': {
        this.endStream();
        const interrupted = Boolean(p.interrupted);
        if (interrupted) process.stdout.write(`\n${yellow('■ interrupted')}\n`);
        break;
      }
      case 'turn/failed':
        this.endStream();
        process.stdout.write(`\n${red(`✗ turn failed: ${String(p.error ?? 'unknown error')}`)}\n`);
        break;
      case 'thread/compacted':
        this.endStream();
        process.stdout.write(`\n${dim('◇ context compacted')}\n`);
        break;
      case 'thread/tokenUsage/updated':
        this.renderUsage(p.usage as ThreadTokenUsage);
        break;
      case 'thread/status/changed':
        this.renderStatus(p as unknown as ThreadStatus);
        break;
      default:
        break;
    }
  }

  private beginStream(): void {
    if (!this.inStream) {
      this.inStream = true;
    }
  }

  private endStream(): void {
    if (this.inStream) {
      this.inStream = false;
      process.stdout.write('\n');
    }
  }

  renderItem(item: Item | undefined): void {
    if (!item) return;
    switch (item.kind) {
      case 'commandExecution': {
        const ce = item as CommandExecutionItem;
        const ok = ce.exitCode === 0;
        const head = `${ok ? green('●') : red('●')} ${bold(ce.command.slice(0, 160))}${ok ? '' : red(` [exit ${ce.exitCode}]`)}`;
        process.stdout.write(`${head}\n`);
        const tail = ce.output.trimEnd().split('\n').slice(-6).join('\n');
        if (tail && tail !== ce.command) {
          process.stdout.write(`${dim(indent(tail, '  '))}\n`);
        }
        break;
      }
      case 'fileChange': {
        const fc = item as FileChangeItem;
        const icon = fc.changeKind === 'add' ? green('+') : fc.changeKind === 'delete' ? red('-') : blue('~');
        process.stdout.write(`${icon} ${bold(fc.path)} ${dim(`(${fc.changeKind})`)}\n`);
        break;
      }
      case 'plan': {
        this.lastPlan = item as PlanItem;
        this.renderPlan(this.lastPlan);
        break;
      }
      case 'agentMessage':
      case 'userMessage':
      case 'reasoning':
      default:
        break;
    }
  }

  renderPlan(plan: PlanItem): void {
    process.stdout.write(`\n${bold('Plan')}\n`);
    for (const step of plan.steps) {
      const mark =
        step.status === 'completed' ? green('✔') : step.status === 'inProgress' ? yellow('▸') : dim('○');
      const text = step.status === 'completed' ? dim(step.content) : step.content;
      process.stdout.write(`  ${mark} ${text}\n`);
    }
    process.stdout.write('\n');
  }

  renderUsage(usage: ThreadTokenUsage | undefined): void {
    if (!usage) return;
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    process.stdout.write(
      dim(`  ↧${k(usage.inputTokens)} ↥${k(usage.outputTokens)} · ctx ${(usage.contextUsage * 100).toFixed(0)}%\n`),
    );
  }

  renderStatus(status: ThreadStatus | undefined): void {
    if (!status || status.lifecycle === 'idle') return;
    process.stdout.write(dim(`  [${status.lifecycle}]\n`));
  }

  banner(version: string, model: string, cwd: string): void {
    const lines = [
      blue('◆') + bold(' smalt') + dim(` v${version}  —  threads · turns · items`),
      dim(`  model ${model}   cwd ${cwd}`),
      dim('  /exit /model /mode /status /plan  ·  Ctrl+C interrupts a turn'),
      '',
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }

  error(msg: string): void {
    process.stdout.write(`${red(`✗ ${msg}`)}\n`);
  }

  info(msg: string): void {
    process.stdout.write(`${dim(msg)}\n`);
  }
}

function indent(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
