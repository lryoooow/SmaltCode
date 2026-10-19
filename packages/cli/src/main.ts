#!/usr/bin/env node
/**
 * smalt CLI
 *
 *   smalt                      interactive REPL in the current directory
 *   smalt -p "do something"    one-shot prompt, then exit
 *   smalt resume <threadId>    continue a saved thread
 *   smalt list                 list saved threads
 *   smalt serve                run the kernel as a stdio JSON-RPC server
 *
 * Model selection:
 *   --model deepseek/deepseek-chat   (provider/model)
 *   --model glm-4.6                  (uses the default provider)
 * API keys come from the provider's env var (e.g. DEEPSEEK_API_KEY) or
 * ~/.smalt/settings.json.
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as readline from 'node:readline';
import {
  Kernel,
  PERMISSION_MODES,
  RpcError,
  createStdioPeer,
  ensureProjectTrust,
  VERSION, killAllToolProcesses,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientPort,
  type PermissionMode,
  type UserInputRequest,
} from '@smalt/kernel';
import { runRepl } from './repl.js';
import { TerminalRenderer } from './render.js';
import { makeAsker, TerminalPort } from './port.js';

process.once('exit', killAllToolProcesses);
process.once('SIGTERM', () => { killAllToolProcesses(); process.exit(143); });

function fail(msg: string): never {
  process.stderr.write(`smalt: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      prompt: { type: 'string', short: 'p' },
      mode: { type: 'string' },
      cwd: { type: 'string' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });
  const sub = positionals[0];
  if (positionals.length > (sub === 'resume' ? 2 : 1)) fail('unexpected positional arguments');
  if (flags.prompt !== undefined && !flags.prompt.trim()) fail('prompt cannot be empty');
  if (flags['no-color']) process.env.NO_COLOR = '1';

  const renderer = new TerminalRenderer();

  if (flags.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (flags.version) {
    process.stdout.write(`smalt ${VERSION}\n`);
    process.exit(0);
  }

  switch (sub) {
    case undefined:
      break; // no subcommand → REPL below
    case 'help':
      process.stdout.write(usage());
      process.exit(0);
      break;
    case 'version':
      process.stdout.write(`smalt ${VERSION}\n`);
      process.exit(0);
      break;
    case 'list': {
      const kernel = await makeKernel(renderer, flags.cwd, { interactive: false });
      const threads = kernel.listThreadsBrief();
      if (!threads.length) {
        renderer.info('no saved threads yet (~/.smalt/threads/)');
      } else {
        for (const t of threads) {
          process.stdout.write(`${t.id}  ${t.updatedAt.slice(0, 16).replace('T', ' ')}  ${t.title}\n`);
        }
      }
      process.exit(0);
      break;
    }
    case 'serve':
      runServer(flags.cwd);
      return;
    case 'resume': {
      const id = positionals[1];
      if (!id) fail('usage: smalt resume <threadId>');
      await runRepl({
        kernel: await makeKernel(renderer, flags.cwd),
        renderer,
        threadId: id,
        model: flags.model,
        mode: parseMode(flags.mode),
        cwd: resolve(flags.cwd ?? process.cwd()),
        initialPrompt: flags.prompt,
      });
      return;
    }
    default:
      fail(`unknown subcommand "${sub}" — try: smalt help`);
  }

  await runRepl({
    kernel: await makeKernel(renderer, flags.cwd),
    renderer,
    model: flags.model,
    mode: parseMode(flags.mode),
    initialPrompt: flags.prompt,
    cwd: resolve(flags.cwd ?? process.cwd()),
  });
}

function parseMode(mode: string | undefined): PermissionMode | undefined {
  if (!mode) return undefined;
  if ((PERMISSION_MODES as readonly string[]).includes(mode)) return mode as PermissionMode;
  return fail(`invalid --mode "${mode}" (one of: ${PERMISSION_MODES.join(', ')})`);
}

async function makeKernel(
  renderer: TerminalRenderer,
  cwdFlag?: string,
  opts?: { interactive?: boolean },
): Promise<Kernel> {
  const cwd = resolve(cwdFlag ?? process.cwd());
  if (cwdFlag && (!existsSync(cwd) || !statSync(cwd).isDirectory())) fail(`cwd is not a directory: ${cwdFlag}`);
  await ensureProjectTrust(
    cwd,
    async (dir) => {
      if (opts?.interactive === false || !process.stdin.isTTY) {
        process.stderr.write(
          `[smalt] ${dir} ships a .smalt/settings.json — NOT trusted (no interactive prompt).\n` +
            `  Its settings apply in restrictive mode. Run smalt in a terminal to trust it.\n`,
        );
        return false;
      }
      process.stdout.write(
        `\nThis project ships its own agent settings:\n  ${join(dir, '.smalt', 'settings.json')}\n` +
          `Trusting it lets the project set allow rules, hooks, and model endpoints.\n`,
      );
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await makeAsker(rl)('Trust this project? [y/N] > ')).trim().toLowerCase();
      rl.close();
      return answer === 'y' || answer === 'yes';
    },
    (msg) => {
      if (process.env.SMALT_DEBUG) process.stderr.write(`[smalt] ${msg}\n`);
    },
  );
  return new Kernel({
    cwd,
    client: new TerminalPort(renderer, (q) => Promise.resolve('')),
    log: (msg) => {
      if (process.env.SMALT_DEBUG) process.stderr.write(`[kernel] ${msg}\n`);
    },
  });
}

/** stdio JSON-RPC server mode: the kernel speaks newline-delimited JSON. */
function runServer(cwdFlag?: string): void {
  const cwd = resolve(cwdFlag ?? process.env.SMALT_CWD ?? process.cwd());
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail('cwd is not a directory');
  const kernel = new Kernel({
    cwd,
    client: {
      notify: () => {},
      requestApproval: () =>
        Promise.resolve({
          decision: 'deny',
          reason: 'serve mode has no interactive approval — add allow rules or change the permission mode',
        } satisfies ApprovalDecision),
      askUser: () => Promise.resolve(''),
    },
    log: (msg) => {
      if (process.env.SMALT_DEBUG) process.stderr.write(`[kernel] ${msg}\n`);
    },
  });
  kernel.threads.recoverInterrupted();

  const peer = createStdioPeer();
  peer.setRequestHandler(async (method, params) => {
    try {
      return await kernel.handle(method, params);
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(-32000, err instanceof Error ? err.message : String(err));
    }
  });

  // kernel → client traffic rides the same peer (reverse requests + notifications)
  const rpcPort: ClientPort = {
    notify: (method, params) => peer.notify(method, params),
    requestApproval: (req: ApprovalRequest) =>
      peer.request('item/requestApproval', req, 300000).catch(() => ({ decision: 'deny', reason: 'approval connection closed or timed out' })) as Promise<ApprovalDecision>,
    askUser: (req: UserInputRequest) =>
      peer.request('item/requestUserInput', req, 300000).catch(() => '') as Promise<string>,
  };
  kernel.setClientPort(rpcPort);

  process.stdin.resume();
  const close = () => {
    for (const meta of kernel.threads.listMetas()) if (kernel.threads.get(meta.id)?.stateMachine.isRunning()) kernel.threads.interrupt(meta.id);
    killAllToolProcesses(); peer.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.stdin.once('end', close); process.stdin.once('error', close);
  process.on('SIGINT', close);
}

function usage(): string {
  return `smalt ${VERSION} — an open, model-agnostic coding agent

USAGE
  smalt [options]              start an interactive session
  smalt -p "<prompt>"          run one prompt, then exit
  smalt resume <threadId>      continue a saved thread
  smalt list                   list saved threads
  smalt serve                  run the kernel as a stdio JSON-RPC server

OPTIONS
  -m, --model <ref>            provider/model (e.g. deepseek/deepseek-chat)
      --mode <name>            permission mode: ${PERMISSION_MODES.join('|')}
      --cwd <dir>              working directory (default: .)
  -p, --prompt <text>          one-shot prompt
      --no-color               disable ANSI colors

API KEYS
  openai: OPENAI_API_KEY     anthropic: ANTHROPIC_API_KEY   deepseek: DEEPSEEK_API_KEY
  zhipu: ZHIPU_API_KEY       moonshot: MOONSHOT_API_KEY     dashscope: DASHSCOPE_API_KEY
  openrouter: OPENROUTER_API_KEY    ollama: none (local)
  Or configure providers in ~/.smalt/settings.json — see the README.

IN-SESSION
  /model /mode /plan /status /cwd /exit   ·  Ctrl+C interrupts a turn
`;
}

main().catch((err) => {
  // no stack traces by default: they leak local paths; SMALT_DEBUG opts in
  const detail = process.env.SMALT_DEBUG
    ? err instanceof Error
      ? (err.stack ?? err.message)
      : String(err)
    : err instanceof Error
      ? err.message
      : String(err);
  process.stderr.write(`smalt: fatal: ${detail}\n`);
  process.exit(1);
});
