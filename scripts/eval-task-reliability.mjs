/** Optional, bounded REAL-provider evaluation. Never part of npm test or CI.
 * Sends only synthetic fixture content. Does not edit user projects/settings.
 * API credentials stay in memory; encrypted desktop keys use Electron safeStorage.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.argv.includes('--live')) {
  console.log('Usage: node scripts/eval-task-reliability.mjs --live [--provider NAME]\nUses the configured provider for synthetic read-only checks; up to 8 requests, 4096 output tokens/request, 180 seconds. Local-only tests: npm test.');
  process.exit(0);
}
const run = join(root, '.qa-work', 'reliability-live-' + Date.now());
await mkdir(run, { recursive: true });
const providerIndex = process.argv.indexOf('--provider');
const config = { root, run, node: process.execPath, provider: providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined };
const harness = join(run, 'evaluate.cjs');
await writeFile(harness, `(${evaluate.toString()})(${JSON.stringify(config)}).catch(e=>{console.error('Evaluation harness failed:', e.name);require('electron').app.exit(1)});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), [harness], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); }, 210_000);
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });

async function evaluate(config) {
  const { app, safeStorage } = require('electron');
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url');
  app.setPath('userData', path.join(config.run, 'electron-data'));
  await app.whenReady();
  const api = await import(pathToFileURL(path.join(config.root, 'packages/kernel/dist/index.js')).href);
  const sourceHome = process.env.SMALT_HOME || path.join(os.homedir(), '.smalt');
  let source;
  try { source = JSON.parse(await fs.readFile(path.join(sourceHome, 'settings.json'), 'utf8')); }
  catch { console.log(JSON.stringify({ status: 'inconclusive', reason: 'No readable configured provider; no model requests sent.' })); app.exit(2); return; }
  const provider = config.provider || source.defaultProvider;
  const cfg = source.providers?.[provider];
  if (!cfg?.baseUrl || cfg.apiKeyEndpoint && api.normalizeEndpoint(cfg.apiKeyEndpoint) !== api.normalizeEndpoint(cfg.baseUrl)) {
    console.log(JSON.stringify({ status: 'inconclusive', reason: 'Provider unavailable or credential endpoint binding changed; no request sent.' })); app.exit(2); return;
  }
  let key = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined);
  if (!key && cfg.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { key = safeStorage.decryptString(Buffer.from(cfg.apiKeyEnc, 'base64')); } catch { /* unavailable on this OS account */ }
  }
  if (!key) { console.log(JSON.stringify({ status: 'inconclusive', reason: 'No usable credential; no request sent.' })); app.exit(2); return; }
  process.env.SMALT_HOME = path.join(config.run, 'home');
  const cwd = path.join(config.run, 'synthetic-workspace'); await fs.mkdir(cwd, { recursive: true });
  const fixtures = {
    'README.md': '# Synthetic reliability fixture\nRead-only evaluation; all checker findings below are deliberate.\n',
    'ruff': "console.log('Would reformat: example.py\\n1 file would be reformatted');process.exit(1);\n",
    'vitest': "const single=process.argv.includes('--isolated');console.log(single?'1 passed':'1 failed | 41 passed\\nTestingLibraryElementError: synthetic missing element');process.exit(single?0:1);\n",
    'pytest': "console.log('115 skipped');process.exit(0);\n",
  };
  for (const [name, content] of Object.entries(fixtures)) await fs.writeFile(path.join(cwd, name), content);
  const settings = api.loadSettings(cwd);
  settings.defaultProvider = provider;
  settings.defaultModel = cfg.defaultModel || source.defaultModel;
  settings.providers = { [provider]: { baseUrl: cfg.baseUrl, wire: cfg.wire || 'chat', defaultModel: settings.defaultModel, contextWindow: cfg.contextWindow || 128000 } };
  settings.hooks = {}; settings.compact.enabled = false;
  settings.permissions = { ...settings.permissions, mode: 'dontAsk', allow: ['shell', 'read'], ask: [], deny: ['edit'] };
  const allowed = [['ruff', 'format', '--check', '.'], ['vitest', 'run'], ['vitest', 'run', '--isolated'], ['pytest', 'integration']];
  const executed = [];
  const kernel = new api.Kernel({ cwd, settings, client: { notify() {}, requestApproval: async () => ({ decision: 'deny', reason: 'Synthetic read-only evaluation; no extra permission.' }), askUser: async () => '根据已有检查继续只读验证，无法验证的项目如实说明。' } });
  kernel.gateway.overrideProvider(provider, { apiKey: key });
  const shell = kernel.tools.get('shell');
  kernel.tools.register({ ...shell, async *run(input, ctx) {
    const matches = input.program === config.node && !input.command && !input.cwd && allowed.some(args => JSON.stringify(args) === JSON.stringify(input.args));
    if (!matches) { yield { type: 'result', text: 'Evaluation guard: only the four exact synthetic program+args checks are allowed. No shell command or source modification.', isError: true }; return; }
    executed.push(input.args); yield* shell.run(input, ctx);
  } });
  let requests = 0;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 180000);
  function instrument(gateway) {
    const stream = gateway.stream.bind(gateway), fork = gateway.fork.bind(gateway);
    gateway.stream = async function* (ref, request) {
      if (++requests > 8) throw new api.ModelError('Live evaluation request budget reached.', 400);
      const signal = AbortSignal.any([deadline.signal, ...(request.signal ? [request.signal] : [])]);
      yield* stream(ref, { ...request, maxOutputTokens: 4096, signal });
    };
    gateway.fork = nextSettings => instrument(fork(nextSettings)); return gateway;
  }
  instrument(kernel.gateway);
  const { threadId } = await kernel.handle('thread/start', { cwd, title: 'Synthetic reliability evaluation' });
  const prompt = `只检查这个合成样例，禁止修改、安装、联网查询或访问其他目录。请实际调用 shell 工具，使用 program=${JSON.stringify(config.node)}，依次执行以下四组 args（每次独立执行，cwd 使用默认）：${JSON.stringify(allowed)}。这是故意包含问题的样例，不要修复或删除检查。格式检查应发现问题；整套测试失败后单个测试通过不能说明整套通过；115 项跳过不能算通过。完成计划后汇报真实结果及未验证范围。`;
  let outcome;
  try { outcome = await kernel.handle('turn/start', { threadId, input: prompt }); }
  finally { clearTimeout(timer); api.killAllToolProcesses(); }
  const read = kernel.threads.read(threadId);
  const commands = read.items.filter(i => i.kind === 'commandExecution' && i.tool === 'shell');
  const unmodified = (await Promise.all(Object.entries(fixtures).map(async ([name, content]) => (await fs.readFile(path.join(cwd, name), 'utf8')) === content))).every(Boolean);
  const checks = {
    allFourChecksExecuted: allowed.every(args => executed.some(value => JSON.stringify(value) === JSON.stringify(args))),
    formatterFinding: commands.some(i => i.assessment?.check === 'format' && i.assessment.kind === 'finding' && i.exitCode === 1),
    suiteFailureRetained: commands.some(i => i.command.includes('vitest run') && !i.command.includes('--isolated') && i.assessment?.kind === 'finding' && !i.assessment.recoveredBy),
    isolatedPass: commands.some(i => i.command.includes('--isolated') && i.exitCode === 0),
    skippedCoverageUnverified: outcome.summary?.assessment?.checks.skipped === 115 && outcome.summary?.assessment?.status === 'unverified',
    planComplete: outcome.summary?.assessment?.pendingSteps === 0,
    substantiveReport: outcome.assistantText.trim().length > 30,
    fixtureUnmodified: unmodified,
  };
  const incomplete = outcome.failed || outcome.interrupted;
  const passed = !incomplete && Object.values(checks).every(Boolean);
  const report = { status: passed ? 'passed' : incomplete ? 'inconclusive' : 'failed', provider, model: settings.defaultModel, requests, checks, assessment: outcome.summary?.assessment, usage: outcome.usage, reason: incomplete ? 'Model request did not complete within the evaluation constraints; inspect the isolated local log.' : undefined, fixture: config.run };
  // Never emit credentials, provider response bodies, or the user's settings.
  await fs.writeFile(path.join(config.run, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(passed ? 0 : 2);
}
