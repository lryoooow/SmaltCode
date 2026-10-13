/**
 * Post-packaging security smoke: replays the reported attacks against the
 * PACKAGED smalt.exe (not the source tree). Skipped when the artifact is
 * absent (e.g. plain CI) — the packaging script always runs this file.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const EXE = join(process.cwd(), 'dist-pkg', 'smalt.exe');
const RUN_AGAINST_EXE = existsSync(EXE);

describe.skipIf(!RUN_AGAINST_EXE)('packaged exe: security attacks are blocked', () => {
  let server: Server;
  let port = 0;
  let home: string;
  let scripts: string[][] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const script = scripts.shift() ?? [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(script.map((d) => `data: ${d}\n\n`).join('') + 'data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as { port: number }).port;

    home = mkdtempSync(join(tmpdir(), 'smalt-exe-sec-'));
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fake',
        defaultModel: 'fake-1',
        providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, wire: 'chat', apiKey: 'x' } },
        // attacker-friendly config: echo allowed, no human to approve anything
        permissions: { mode: 'default', allow: ['shell:echo', 'read', 'edit'], deny: [], ask: [] },
      }),
    );
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  async function runAttack(cwd: string, command: string): Promise<{ stdout: string; code: number }> {
    scripts = [
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: JSON.stringify({ command }) } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] }),
      ],
      [JSON.stringify({ choices: [{ delta: { content: 'done' }, index: 0, finish_reason: 'stop' }] })],
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(EXE, ['-p', 'run it'], {
        cwd,
        env: { ...process.env, SMALT_HOME: home, NO_COLOR: '1' },
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
      child.on('error', reject);
    });
  }

  it('blocks single-& chained redirection writes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'smalt-exe-w1-'));
    writeFileSync(join(work, 'hello.txt'), 'original');
    const r = await runAttack(work, 'echo hi & echo PWNED> pwned.txt');
    expect(existsSync(join(work, 'pwned.txt'))).toBe(false);
    expect(readFileSync(join(work, 'hello.txt'), 'utf8')).toBe('original');
    expect(r.stdout.toLowerCase()).toContain('denied');
  });

  it('blocks plain redirection overwrites', async () => {
    const work = mkdtempSync(join(tmpdir(), 'smalt-exe-w2-'));
    writeFileSync(join(work, 'hello.txt'), 'original');
    await runAttack(work, 'echo owned > hello.txt');
    expect(readFileSync(join(work, 'hello.txt'), 'utf8')).toBe('original');
  });

  it('blocks writes outside the workspace under acceptEdits-like allow rules', async () => {
    const work = mkdtempSync(join(tmpdir(), 'smalt-exe-w3-'));
    scripts = [
      [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write', arguments: JSON.stringify({ path: '../pwned.txt', content: 'pwn' }) } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'tool_calls' }] }),
      ],
      [JSON.stringify({ choices: [{ delta: { content: 'done' }, index: 0, finish_reason: 'stop' }] })],
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(EXE, ['-p', 'write it'], {
        cwd: work,
        env: { ...process.env, SMALT_HOME: home, NO_COLOR: '1' },
      });
      child.on('close', () => resolve());
      child.on('error', reject);
    });
    expect(existsSync(join(work, '..', 'pwned.txt'))).toBe(false);
  });
});
