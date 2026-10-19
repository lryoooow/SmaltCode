import { VERSION } from '@smalt/kernel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { makeAsker, installInterrupts } from '../src/port.js';
let root: string, home: string, cwd: string, target: string, server: Server, env: NodeJS.ProcessEnv;
let modelRequests: any[] = [];
const processes = new Set<ChildProcessWithoutNullStreams>();
const cli = join(process.cwd(), 'packages/cli/dist/main.js');
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'smalt-cli-regressions-')); home = join(root, 'home'); cwd = join(root, 'initial'); target = join(root, 'target');
  for (const path of [home, cwd, target]) mkdirSync(path);
  writeFileSync(join(target, 'where.txt'), 'ONLY IN SELECTED WORKSPACE');
  server = createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
    const request = JSON.parse(body); modelRequests.push(request);
    const text = request.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n');
    const tool = request.messages.at(-1).role === 'tool';
    const delta = !tool && text.includes('read selected') ? { tool_calls: [{ index: 0, id: 'read', function: { name: 'read', arguments: '{"path":"where.txt"}' } }] } : !tool && text.includes('approval fixture') ? { tool_calls: [{ index: 0, id: 'write', function: { name: 'write', arguments: '{"path":"forbidden.txt","content":"never"}' } }] } : { content: 'fixture completed' };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', providers: { fixture: { wire: 'chat', baseUrl: 'http://127.0.0.1:' + (server.address() as any).port + '/v1', apiKey: 'local-only-fixture' } } }));
  env = { ...process.env, SMALT_HOME: home, NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NODE_OPTIONS)/i.test(name)) delete env[name];
});
afterAll(async () => { for (const child of processes) child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
function launch(args: string[]) { const child = spawn(process.execPath, [cli, ...args], { cwd, env, windowsHide: true }); processes.add(child); child.once('close', () => processes.delete(child)); return child; }
async function once(args: string[]) {
  const child = launch(args); let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data); child.stdin.end();
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.once('close', code => resolve({ code, stdout, stderr })));
}
it('stdio serve has only JSON output, no unsolicited model call, reverse approval and clean EOF', async () => {
  const child = launch(['serve', '--cwd', target]), received: any[] = [], pending = new Map<number, (message: any) => void>();
  const malformed: string[] = []; let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { let message: any; try { message = JSON.parse(line); } catch { malformed.push(line); return; } received.push(message);
    if (message.method === 'item/requestApproval') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { decision: 'deny' } }) + '\n');
    else if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  const request = (method: string, params?: object) => new Promise<any>((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(Error('RPC timeout: ' + method)), 3000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const count = modelRequests.length; const init = await request('initialize'); expect(init.result.kernelInfo.version).toBe(VERSION); expect(modelRequests.length).toBe(count);
  const start = await request('thread/start', { cwd: target }); const result = await request('turn/start', { threadId: start.result.threadId, input: 'approval fixture' });
  expect(result.result.failed).toBe(false); expect(received.some(message => message.method === 'item/requestApproval')).toBe(true);
  expect(existsSync(join(target, 'forbidden.txt'))).toBe(false); expect(malformed).toEqual([]);
  const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await closed;
});
it('--cwd controls real tool reads and resume does not create an extra thread', async () => {
  const result = await once(['--cwd', target, '-p', 'read selected']); expect(result.code).toBe(0);
  const last = modelRequests.at(-1); expect(last.messages.find((m: any) => m.role === 'tool').content).toContain('ONLY IN SELECTED WORKSPACE');
  const files = readdirSync(join(home, 'threads')).filter(name => name.endsWith('.jsonl'));
  const file = files.find(name => readFileSync(join(home, 'threads', name), 'utf8').includes('read selected'))!;
  const resumed = await once(['--cwd', target, 'resume', file.slice(0, -6), '-p', 'resume fixture']); expect(resumed.code).toBe(0);
  expect(readdirSync(join(home, 'threads')).filter(name => name.endsWith('.jsonl'))).toHaveLength(files.length);
});
it('rejects an empty one-shot prompt without contacting a model', async () => {
  const count = modelRequests.length; const result = await once(['-p', '']); expect(result.code).not.toBe(0); expect(result.stderr).toContain('empty'); expect(modelRequests.length).toBe(count);
});
it('settles active and subsequent readline questions when input closes', async () => {
  const input = new PassThrough(), output = new PassThrough(), rl = createInterface({ input, output }); const ask = makeAsker(rl); const answer = ask('approve?'); input.end();
  expect(await answer).toBe(''); expect(await ask('again?')).toBe('');
});
it('wires actual terminal Ctrl+C keypresses to the shared interrupt handler', async () => {
  const input = new PassThrough(), output = new PassThrough(), rl = createInterface({ input, output, terminal: true }); let calls = 0;
  const remove = installInterrupts(rl, () => calls++); input.write('\u0003'); input.write('\u0003');
  expect(calls).toBe(2); remove(); rl.close();
});
