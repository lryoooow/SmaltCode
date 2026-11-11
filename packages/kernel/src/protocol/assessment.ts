/** Evidence-derived results shared by the kernel and renderer; no OS imports. */
export type CheckKind = 'format' | 'test' | 'lint' | 'typecheck' | 'build';
export interface ExecutionAssessment {
  kind: 'success' | 'finding' | 'unverified' | 'error' | 'interrupted';
  summary: string;
  code?: 'commandUnavailable' | 'invalidInvocation' | 'exitCodeConflict' | 'shellStatusMasked' | 'timeout' | 'spawnError';
  check?: CheckKind;
  operationKey?: string;
  skipped?: number;
  recoveredBy?: string;
  recovery?: 'retry' | 'alternative';
  exitCode?: number | null;
  source?: 'process' | 'shell';
}
export interface TurnAssessment {
  status: 'completed' | 'findings' | 'unverified' | 'needsAttention' | 'interrupted';
  intent: 'inspect' | 'change' | 'other';
  checks: { passed: number; findings: number; unverified: number; skipped: number };
  unresolved: string[];
  recovered: number;
  pendingSteps: number;
  verificationMissing?: boolean;
}
export function taskIntent(text: string): TurnAssessment['intent'] {
  const clean = text.replace(/\n\n用户(?:为本次任务选择的工作流程|选择的文件引用|保存的记忆资料)[\s\S]*$/, '').trim();
  if (/只(?:读|检查|审查|分析|做检查|做审查)|仅(?:检查|审查|分析|阅读|查看)|(?:禁止|不(?:要|许|得|能|用|的)?|别|勿)(?:修改|改动)(?:代码|文件|内容)?(?:[，。；！,.!;\s]|$)|read.only|do not (?:edit|modify)|review only/i.test(clean)) return 'inspect';
  return /修复|实现|新增|优化|修改|创建|重构|implement|\b(?:fix|refactor|edit|create)\b/i.test(clean) ? 'change' : 'other';
}
export function displayCommand(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  return [input.program ?? '', ...(Array.isArray(input.args) ? input.args : [])].map(v => /^[\p{L}\p{N}_./\\:@=+-]+$/u.test(String(v)) ? String(v) : JSON.stringify(String(v))).join(' ');
}
function checkKind(command: string): CheckKind | undefined {
  const words = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map(w => w.replace(/^(["'])([\s\S]*)\1$/, '$2')) ?? [];
  const executable = words[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, '').toLowerCase();
  if (['echo', 'rem', 'printf'].includes(executable ?? '') || /^(?:node|python[\d.]*)$/.test(executable ?? '') && words.some(w => w === '-e' || w === '-c')) return undefined;
  if (/(?:^|\s)(?:--show-settings|--show-files|--help|--version|-V)(?:\s|$)/i.test(command)) return undefined;
  if (/\bruff\b[\s"']+format\b.*--check|\bprettier\b.*--check/i.test(command)) return 'format';
  if (/\bpytest\b|\bvitest\b|\bjest\b|\bnode(?:\.exe)?\b.*--test\b|\b(?:npm|pnpm|yarn|cargo|go|dotnet)\b.*\btest\b/i.test(command)) return 'test';
  if (/\btsc\b|\btypecheck\b|\bmypy\b|\bpyright\b/i.test(command)) return 'typecheck';
  if (/\bruff\b[\s"']+check\b|\beslint\b|\b(?:npm|pnpm|yarn)\b.*\blint\b/i.test(command)) return 'lint';
  if (/\b(?:npm|pnpm|yarn|cargo|dotnet|vite)\b.*\bbuild\b/i.test(command)) return 'build';
}
function isBenignProbeExit(command: string, text: string, exitCode: number | null, check?: CheckKind): boolean {
  if (exitCode !== 1 || check) return false;
  if (!/(?:^|[|&;])\s*(?:findstr|grep|rg|where|which)\b|\b2>\s*(?:nul|\/dev\/null)\b/i.test(command)) return false;
  const body = text.replace(/^\[exit -?\d+\]\s*/m, '').replace(/\n?\[assessment:[\s\S]*$/m, '').trim();
  return !/not recognized|command not found|无法将.+识别|SyntaxError|Traceback|[\w.]+(?:Error|Exception):|Permission denied|Access is denied|拒绝访问|cannot open|无法打开|Cannot find|找不到|parameter format not correct|参数格式不正确|invalid|unknown option|unrecognized|ENOENT/i.test(body);
}
export function executionAssessment(command: string, output: string, exitCode: number | null, source: 'process' | 'shell' = 'shell', cwd = ''): ExecutionAssessment {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const check = checkKind(command);
  // Deliberately exact. An isolated passing test must never erase a suite failure,
  // and package-script argument forwarding is not necessarily equivalent to exec.
  const operationKey = check ? JSON.stringify([cwd.replace(/\\/g, '/'), command.trim()]) : undefined;
  const base = { check, operationKey, exitCode, source };
  if (/\[interrupted\]|^Interrupted$|Cancelled before execution/.test(text)) return { ...base, kind: 'interrupted', summary: '操作在完成前停止' };
  if (/\[timed out\]/.test(text)) return { ...base, kind: 'error', code: 'timeout', summary: '操作超时，需检查后继续' };
  if (exitCode !== 0 && /not recognized as an internal|command not found|:\s*[\w.-]+:\s*not found|spawn .+ ENOENT|无法将.+识别|execvpe\(\/bin\/(?:bash|sh)\) failed/i.test(text)) return { ...base, kind: 'error', code: 'commandUnavailable', summary: '当前环境没有该命令，请使用可用程序或独立文件搜索工具' };
  if (/\[spawn error\]/.test(text)) return { ...base, kind: 'error', code: 'spawnError', summary: '程序未能启动' };
  if (exitCode !== 0 && /unknown (?:option|argument)|unrecognized arguments?|invalid (?:option|argument)|UsageError:|failed to parse|unexpected argument/i.test(text)) return { ...base, kind: 'error', code: 'invalidInvocation', summary: '检查未能按预期启动，请核对参数与工具版本' };
  const skipped = Math.max(0, ...Array.from(text.matchAll(/\b(\d+) skipped\b|^#\s+skipped\s+(\d+)\s*$/gim), m => Number(m[1] ?? m[2])));
  const testFailed = /\b[1-9]\d* failed\b|^\s*FAIL(?:ED)?\s|ELIFECYCLE.*failed/im.test(text);
  const finding = check === 'format' && /Would reformat|files? would be reformatted|Code style issues found/i.test(text)
    || check === 'test' && testFailed
    || check === 'lint' && /Found \d+ errors?|\b[1-9]\d* problems?\b/i.test(text)
    || check === 'typecheck' && /error TS\d+|Found \d+ errors?/i.test(text)
    || check === 'build' && /error TS\d+|error during build|Build failed/i.test(text);
  if (check && exitCode === 0 && finding) return { ...base, kind: 'unverified', code: 'exitCodeConflict', summary: '输出报告检查失败，但外层命令返回 0；请单独执行检查，核实真实结果', skipped };
  if (source === 'shell' && check && hasStatusMask(command)) return { ...base, kind: 'unverified', code: 'shellStatusMasked', summary: '复合命令可能覆盖检查退出码，请单独运行检查', skipped };
  if ((exitCode === 1 || exitCode === 2 && (check === 'typecheck' || check === 'build')) && finding) return { ...base, kind: 'finding', summary: check === 'format' ? '格式检查已完成，发现待格式化文件' : '检查已执行，发现项目问题', skipped };
  if (isBenignProbeExit(command, text, exitCode, check)) return { ...base, kind: 'success', summary: '操作完成' };
  if (exitCode !== 0) return { ...base, kind: 'error', summary: '操作执行失败，请核对原始输出', ...(check && skipped ? { skipped } : {}) };
  if (check && skipped > 0) return { ...base, kind: 'unverified', summary: `检查结束，${skipped} 项跳过，覆盖尚不完整`, skipped };
  return { ...base, kind: 'success', summary: check ? '检查通过' : '操作完成' };
}

function hasStatusMask(command: string): boolean {
  const body = command.replace(/^\s*cd(?:\s+\/d)?\s+(?:"[^"]*"|'[^']*'|[^&;|\r\n]+?)\s*&&\s*/i, '');
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'") { if (!quote) quote = c; else if (quote === c) quote = ''; continue; }
    if (!quote && /[&;|\r\n]/.test(c)) {
      if (c === '&' && /[<>]$/.test(body.slice(0, i)) && /[\d-]/.test(body[i + 1] ?? '')) continue;
      return true;
    }
  }
  return false;
}

/** Conservative equivalence for an explicit process rerun of a masked check.
 * No directory changes, variables, argument rewriting, or package-script exec
 * equivalence are inferred. Complex cases remain unverified. */
export function verifiesSameCheck(prior: { command: string; assessment: ExecutionAssessment }, next: { command: string; assessment: ExecutionAssessment }): boolean {
  const a = prior.assessment, b = next.assessment;
  if (!a.check || !['finding', 'unverified'].includes(a.kind) || a.check !== b.check || b.source !== 'process' || !['success', 'finding'].includes(b.kind)) return false;
  const cwd = (key?: string) => { try { return JSON.parse(key ?? '[]')[0]; } catch { return undefined; } };
  if (!a.operationKey || !b.operationKey || cwd(a.operationKey) !== cwd(b.operationKey)) return false;
  const base = (command: string) => {
    if (/^\s*cd\b/i.test(command)) return undefined;
    let quote = '', end = command.length;
    for (let i = 0; i < command.length; i++) {
      const c = command[i]!;
      if (c === '"' || c === "'") { if (!quote) quote = c; else if (quote === c) quote = ''; }
      else if (!quote && /[&;|]/.test(c)) { if (c === '&' && />$/.test(command.slice(0, i)) && /\d/.test(command[i + 1] ?? '')) continue; end = i; break; }
    }
    const prefix = command.slice(0, end).replace(/\s+2>&1\s*$/, '').trim();
    return /[%`$\r\n]/.test(prefix) ? undefined : { prefix, tail: command.slice(end) };
  };
  const x = base(prior.command), y = base(next.command);
  if (!x || !y || x.prefix !== y.prefix || y.tail) return false;
  // Revalidating a check does not prove an unrelated trailing operation worked.
  return !x.tail || /^[&;|]+\s*(?:echo|tail|head|grep|findstr)\b/i.test(x.tail) && !hasStatusMask(x.tail.replace(/^[&;|]+\s*/, ''));
}

export function missingProgram(output: string): string | undefined {
  const windows = /(?:^|\n)\s*['"]?([\w.-]+)['"]? is not recognized as an internal/i.exec(output);
  const posix = /(?:^|\n)\s*(?:[^\n:]*:\s*(?:\d+:\s*)?)?([\w.-]+):\s*(?:command )?not found/i.exec(output);
  return windows?.[1] ?? posix?.[1] ?? /\bspawn ([\w.-]+) ENOENT/.exec(output)?.[1] ?? /无法将[“"']([^”"']+)[”"'](?:项)?识别/.exec(output)?.[1] ?? /execvpe\(\/bin\/(bash|sh)\) failed/i.exec(output)?.[1];
}

function isExploratoryShellProbe(command: string, assessment: ExecutionAssessment): boolean {
  if (assessment.check || assessment.kind !== 'error') return false;
  if (assessment.code === 'commandUnavailable') return true;
  return /^\s*(?:(?:cd\s+[^&;|]+\s*[&;|]+\s*)*(?:dir|ls|find|findstr|grep|rg|where|which|type|cat|head|tail|bash\s+-c\s+["']\s*(?:ls|find|grep|cat|head|tail))\b|cd\b)/i.test(command);
}

import type { Item } from './types.js';
/** Legacy records derive the same result without rewriting saved history. */
export function itemAssessment(item: Item): ExecutionAssessment | undefined {
  if (item.kind !== 'commandExecution' || item.status === 'inProgress' || item.status === 'blocked') return undefined;
  if (item.assessment) {
    if (item.assessment.code === 'shellStatusMasked' && !checkKind(item.command) && item.exitCode === 0) {
      return { ...item.assessment, check: undefined, operationKey: undefined, code: undefined, kind: 'success', summary: '操作完成' };
    }
    if (item.assessment.code === 'shellStatusMasked' && !hasStatusMask(item.command)) {
      const cwd = (() => { try { return JSON.parse(item.assessment.operationKey ?? '[]')[0] ?? ''; } catch { return ''; } })();
      return { ...executionAssessment(item.command, item.output, item.exitCode, item.assessment.source, cwd), ...(item.assessment.recoveredBy ? { recoveredBy: item.assessment.recoveredBy, recovery: item.assessment.recovery } : {}) };
    }
    if (item.assessment.kind === 'error' && !item.assessment.code && isBenignProbeExit(item.command, item.output, item.exitCode, item.assessment.check)) {
      return { ...item.assessment, kind: 'success', summary: '操作完成' };
    }
    if (item.assessment.kind === 'error' && !item.assessment.code && /execvpe\(\/bin\/(?:bash|sh)\) failed/i.test(item.output)) {
      return { ...item.assessment, code: 'commandUnavailable', summary: '当前环境没有该命令，请使用可用程序或独立文件搜索工具' };
    }
    return item.assessment;
  }
  if (item.tool && item.tool !== 'shell') return undefined;
  return executionAssessment(item.command, item.output, item.exitCode);
}

/** True when a failed fileChange or native read/glob/grep was succeeded by a completed one in the same turn. */
export function isSupersededOperation(item: Item, items: Item[]): boolean {
  if (item.status !== 'failed') return false;
  const idx = items.indexOf(item);
  if (idx < 0) return false;
  for (let i = idx + 1; i < items.length; i++) {
    const later = items[i]!;
    if (later.turnId !== item.turnId || later.status !== 'completed') continue;
    if (item.kind === 'fileChange' && later.kind === 'fileChange' && (!item.path || later.path === item.path)) return true;
    if (item.kind === 'commandExecution' && (item.tool === 'read' || item.tool === 'glob' || item.tool === 'grep') && later.kind === 'commandExecution' && (later.tool === 'read' || later.tool === 'glob' || later.tool === 'grep')) return true;
  }
  return false;
}

/** Only an identical or broader check with a trustworthy later result, or a recovered exploratory probe, supersedes a retry. */
export function operationAssessments(items: Item[]): Map<string, ExecutionAssessment> {
  const results = new Map<string, ExecutionAssessment>();
  const latest = new Map<string, string>();
  const itemById = new Map<string, Item>();
  for (const item of items) {
    itemById.set(item.id, item);
    const a = itemAssessment(item);
    if (a) results.set(item.id, { ...a });
    if (item.kind === 'commandExecution' && item.status === 'completed' && (!a || a.kind === 'success' || a.kind === 'finding' || a.kind === 'unverified')) {
      const isNativeInspect = item.tool === 'read' || item.tool === 'glob' || item.tool === 'grep';
      for (const [priorId, prior] of results) {
        if (priorId === item.id || prior.recoveredBy) continue;
        const priorItem = itemById.get(priorId);
        if (!priorItem || priorItem.turnId !== item.turnId || priorItem.kind !== 'commandExecution' || priorItem.status === 'blocked') continue;
        if ((isNativeInspect || a?.kind === 'success') && isExploratoryShellProbe(priorItem.command, prior)) {
          results.set(priorId, { ...prior, recoveredBy: item.id, recovery: isNativeInspect ? 'alternative' : 'retry' });
          continue;
        }
        if (a?.check && prior.check === a.check && prior.kind !== 'success') {
          const priorCwd = (() => { try { return JSON.parse(prior.operationKey ?? '[]')[0]; } catch { return undefined; } })();
          const curCwd = (() => { try { return JSON.parse(a.operationKey ?? '[]')[0]; } catch { return undefined; } })();
          if (priorCwd !== undefined && priorCwd === curCwd) {
            const priorCmd = priorItem.command.trim(), curCmd = item.command.trim();
            if (a.kind === 'success' && (prior.kind === 'error' || priorCmd.startsWith(curCmd + ' '))) {
              results.set(priorId, { ...prior, recoveredBy: item.id, recovery: 'retry' });
              continue;
            }
            if ((prior.code === 'shellStatusMasked' || prior.code === 'exitCodeConflict') && !a.code && (a.kind === 'success' || a.kind === 'finding' || prior.code === 'shellStatusMasked')) {
              results.set(priorId, { ...prior, recoveredBy: item.id, recovery: 'retry' });
              continue;
            }
            if (a.check === 'format' && prior.kind === 'finding' && a.kind === 'finding') {
              results.set(priorId, { ...prior, recoveredBy: item.id, recovery: 'retry' });
              continue;
            }
          }
        }
      }
    }
    if (!a?.operationKey) continue;
    const key = `${item.turnId}:${a.operationKey}`, prior = latest.get(key);
    if (prior && (a.kind === 'success' || a.kind === 'finding')) {
      const previous = results.get(prior)!;
      if (previous.kind !== 'success') results.set(prior, { ...previous, recoveredBy: item.id, recovery: 'retry' });
    }
    latest.set(key, item.id);
  }
  return results;
}

export function assessTurn(items: Item[], input: string, interrupted = false): TurnAssessment {
  const steering = items.findLast(i => i.kind === 'userMessage' && taskIntent(i.text) !== 'other');
  const intent = taskIntent(steering?.kind === 'userMessage' ? steering.text : input), results = operationAssessments(items);
  const checks = { passed: 0, findings: 0, unverified: 0, skipped: 0 };
  const unresolved: string[] = [];
  let recovered = 0;
  for (const item of items) {
    if (item.kind === 'userMessage' || item.kind === 'agentMessage' || item.kind === 'reasoning' || item.kind === 'plan') continue;
    const a = results.get(item.id);
    if (a?.recoveredBy || (!a && isSupersededOperation(item, items))) { recovered++; continue; }
    if (a?.check) {
      checks.skipped += a.skipped ?? 0;
      if (a.kind === 'success') checks.passed++;
      else if (a.kind === 'finding') checks.findings++;
      else if (a.kind === 'unverified') checks.unverified++;
    }
    if (a?.kind === 'error' || a?.kind === 'interrupted' || (!a && (item.status === 'failed' || item.status === 'blocked'))) unresolved.push(item.id);
  }
  const plan = items.findLast(i => i.kind === 'plan');
  const pendingSteps = plan?.kind === 'plan' ? plan.steps.filter(s => s.status !== 'completed').length : 0;
  const verificationMissing = intent === 'change' && !checks.passed && !checks.findings && !checks.unverified && items.some(i => i.kind === 'fileChange' && i.status === 'completed' && /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|c|h|swift|kt|vue|svelte)$/i.test(i.path));
  const status = interrupted ? 'interrupted' : unresolved.length || pendingSteps || (intent !== 'inspect' && checks.findings) ? 'needsAttention' : checks.unverified || checks.skipped || verificationMissing ? 'unverified' : checks.findings ? 'findings' : 'completed';
  return { status, intent, checks, unresolved, recovered, pendingSteps, ...(verificationMissing ? { verificationMissing: true } : {}) };
}

export const assessmentLabels: Record<TurnAssessment['status'], string> = { completed: '已完成', findings: '检查完成，发现问题', unverified: '部分验证未完成', needsAttention: '仍有事项需处理', interrupted: '已停止' };
