/** The interactive REPL: one thread, streaming output, steering, commands. */

import * as readline from 'node:readline';
import { Kernel, PERMISSION_MODES, type PermissionMode, type ThreadMeta } from '@smalt/kernel';
import { makeAsker } from './port.js';
import { TerminalPort } from './port.js';
import { TerminalRenderer } from './render.js';

export interface ReplOptions {
  kernel: Kernel;
  renderer: TerminalRenderer;
  threadId?: string;
  model?: string;
  mode?: PermissionMode;
  initialPrompt?: string;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { kernel, renderer } = opts;

  if (opts.initialPrompt) {
    await runOneShot(opts);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'you> ',
  });
  const ask = makeAsker(rl);
  const port = new TerminalPort(renderer, ask);
  kernel.setClientPort(port);
  const activeKernel = kernel;

  let meta: ThreadMeta = activeKernel.threads.start({
    cwd: process.cwd(),
    model: opts.model,
  }).meta;
  if (opts.threadId) {
    meta = activeKernel.threads.resume(opts.threadId).meta;
    renderer.info(`resumed ${meta.title} (${meta.turnCount} turns)`);
  }
  if (opts.mode) {
    activeKernel.getPermissions().setMode(opts.mode);
  }

  renderer.banner('0.0.1', `${meta.provider ?? ''}/${meta.model}`.replace(/^\//, ''), meta.cwd);

  let running = false;
  let interruptedOnce = false;
  let exitWhenIdle = false;

  const send = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    running = true;
    interruptedOnce = false;
    try {
      await activeKernel.handle('turn/start', { threadId: meta.id, input: text });
    } catch (err) {
      renderer.error(err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
      if (exitWhenIdle) {
        rl.close();
        setTimeout(() => process.exit(0), 100).unref();
      } else {
        rl.setPrompt('you> ');
        rl.prompt();
      }
    }
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      if (!running) rl.prompt();
      return;
    }
    if (running) {
      // mid-turn input steers the agent
      const r = activeKernel.threads.steer(meta.id, text);
      renderer.info(r.queued ? '  (queued as steering message)' : '  (started)');
      return;
    }
    if (text.startsWith('/')) {
      void handleCommand(text);
      return;
    }
    void send(text);
  });

  rl.on('close', () => {
    // stdin hit EOF (piped input, Ctrl+D). If a turn is still running, wait
    // for it instead of killing the process mid-flight.
    if (running) {
      exitWhenIdle = true;
      return;
    }
    process.stdout.write('\n');
    process.exit(0);
  });

  // Ctrl+C: first press interrupts the running turn, second exits
  process.on('SIGINT', () => {
    if (running && !interruptedOnce) {
      interruptedOnce = true;
      renderer.info('\n  (interrupting… press Ctrl+C again to exit)');
      activeKernel.threads.interrupt(meta.id);
      return;
    }
    process.stdout.write('\nbye\n');
    process.exit(0);
  });

  async function handleCommand(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd) {
      case 'exit':
      case 'quit':
      case 'q':
        process.stdout.write('bye\n');
        process.exit(0);
        break;
      case 'model': {
        if (!arg) {
          const cur = activeKernel.currentModelMeta();
          renderer.info(`current model: ${cur.provider}/${cur.model}`);
          renderer.info('usage: /model <provider/model>  (providers: ' + Object.keys(activeKernel.getSettings().providers).join(', ') + ')');
        } else {
          const rt = activeKernel.threads.get(meta.id);
          if (rt) {
            const ref = await import('@smalt/kernel').then((m) => m.resolveModelRef(arg, activeKernel.getSettings()));
            rt.modelRef.provider = ref.provider;
            rt.modelRef.model = ref.model;
            renderer.info(`model set to ${ref.provider}/${ref.model}`);
          }
        }
        break;
      }
      case 'mode': {
        if (!arg || !(PERMISSION_MODES as readonly string[]).includes(arg)) {
          renderer.info(`current mode: ${activeKernel.getPermissions().mode}`);
          renderer.info(`usage: /mode <${PERMISSION_MODES.join('|')}>`);
        } else {
          activeKernel.getPermissions().setMode(arg as PermissionMode);
          renderer.info(`permission mode: ${arg}`);
        }
        break;
      }
      case 'plan':
        activeKernel.getPermissions().setMode('plan');
        renderer.info('plan mode ON — only read-only tools run; /mode default to leave');
        break;
      case 'status': {
        const s = activeKernel.threads.status(meta.id);
        renderer.info(`lifecycle=${s.lifecycle} state=${s.state} queued=${s.queuedMessages}`);
        break;
      }
      case 'cwd':
        renderer.info(meta.cwd);
        break;
      case 'help':
        renderer.info('commands: /exit /model <ref> /mode <name> /plan /status /cwd');
        break;
      default:
        renderer.info(`unknown command: ${cmd} (try /help)`);
    }
    rl.prompt();
  }

  rl.prompt();

  // keep the process alive while waiting for input
  await new Promise<void>(() => {});
}

/**
 * One-shot mode (`smalt -p "…"`): no REPL loop, no readline on stdin (which
 * is often a closed pipe in this mode). Approvals are interactive only when
 * stdin is a TTY; otherwise unapproved calls are denied — the safe default.
 */
async function runOneShot(opts: ReplOptions): Promise<void> {
  const { kernel, renderer } = opts;

  const interactive = process.stdin.isTTY === true;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = rl
    ? makeAsker(rl)
    : (_q: string) => {
        // non-interactive stdin: every question resolves to "no" so unapproved
        // calls fail closed (the empty-string path in TerminalPort denies too)
        renderer.info('(non-interactive stdin — approval unavailable, treating as no)');
        return Promise.resolve('n');
      };

  const port = new TerminalPort(renderer, ask);
  kernel.setClientPort(port);

  const meta = opts.threadId
    ? kernel.threads.resume(opts.threadId).meta
    : kernel.threads.start({ cwd: process.cwd(), model: opts.model }).meta;
  if (opts.mode) kernel.getPermissions().setMode(opts.mode);

  try {
    const outcome = (await kernel.handle('turn/start', {
      threadId: meta.id,
      input: opts.initialPrompt ?? '',
    })) as { failed: boolean; error?: string; interrupted: boolean };
    if (outcome.failed) process.exitCode = 1;
    if (outcome.interrupted) process.exitCode = 130;
  } catch (err) {
    renderer.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    rl?.close();
    // let undici keep-alive sockets drain before a forced exit (Windows libuv
    // asserts otherwise); an empty loop exits on its own sooner
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  }
}
