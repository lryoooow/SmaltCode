/**
 * End-to-end smoke test: a fake OpenAI-compatible server + the real CLI
 * binary, exercising the full path
 * HTTP SSE → chat adapter → turn loop → tools → approval → output.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const CLI = join(process.cwd(), 'packages', 'cli', 'dist', 'main.js');

let server: Server;
let port = 0;
let home: string;
let workdir: string;
/** scripts the fake model serves, one per /chat/completions call */
let scripts: string[][] = [];

function sse(deltas: string[]): string {
  return deltas.map((d) => `data: ${d}\n\n`).join('') + 'data: [DONE]\n\n';
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith('/chat/completions')) {
      const script = scripts.shift() ?? [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(script));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;

  home = mkdtempSync(join(tmpdir(), 'smalt-home-'));
  mkdirSync(join(home), { recursive: true });
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fake',
      defaultModel: 'fake-1',
      providers: {
        fake: { baseUrl: `http://127.0.0.1:${port}/v1`, wire: 'chat', apiKey: 'test' },
      },
      permissions: { mode: 'default', allow: ['shell:echo'], deny: [], ask: [] },
    }),
    'utf8',
  );

  workdir = mkdtempSync(join(tmpdir(), 'smalt-work-'));
  writeFileSync(join(workdir, 'hello.txt'), 'greetings from the file\n');
});

afterAll(async () => {
  server.close();
});

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: workdir,
      env: { ...process.env, SMALT_HOME: home, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', reject);
  });
}

describe('CLI end-to-end against a fake model server', () => {
  it('help and version work without any API', async () => {
    const help = await runCli(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('smalt');

    const version = await runCli(['version']);
    expect(version.stdout).toContain('0.0.1');
  });

  it('--help and --version flags work and never print a stack trace', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('USAGE');
    expect(help.stderr).not.toContain('at ');

    const version = await runCli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe('smalt 0.0.1');
    expect(version.stderr).toBe('');
  });

  it('runs a full turn: model calls read tool, then answers', async () => {
    scripts = [
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"path":"hello.txt"}' } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] }),
      ],
      [
        JSON.stringify({ choices: [{ delta: { content: 'THE FILE SAYS: ' }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: { content: 'greetings' }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }),
      ],
    ];
    const result = await runCli(['-p', 'read hello.txt and tell me what it says']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('THE FILE SAYS: greetings');
    // the read tool ran for real (its item rendered into the transcript)
    expect(result.stdout).toContain('read');
  });

  it('runs an allowed shell command without prompting', async () => {
    scripts = [
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: '{"command":"echo smalt-e2e-ok"}' } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] }),
      ],
      [JSON.stringify({ choices: [{ delta: { content: 'echoed' }, index: 0, finish_reason: 'stop' }] })],
    ];
    const result = await runCli(['-p', 'run the echo']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('smalt-e2e-ok');
  });

  it('REGRESSION: unapproved commands fail closed on non-interactive stdin', async () => {
    // attack: allowed `echo` rule, chained write via single & + redirection
    scripts = [
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: '{"command":"echo hi & echo PWNED> pwned.txt"}' } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] }),
      ],
      [JSON.stringify({ choices: [{ delta: { content: 'done' }, index: 0, finish_reason: 'stop' }] })],
    ];
    const result = await runCli(['-p', 'run it']);
    // stdin is a closed pipe: the approval prompt must resolve to DENY,
    // never auto-allow, and nothing may be written
    expect(existsSync(join(workdir, 'pwned.txt'))).toBe(false);
    expect(result.stdout.toLowerCase()).toContain('denied');
  });

  it('persisted the thread and can list it', async () => {
    const list = await runCli(['list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/th_/);
  });
});
