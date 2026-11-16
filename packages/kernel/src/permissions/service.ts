/**
 * The permission chain — checked in a fixed order before any tool runs:
 *
 *   1. deny rules        (hard stop, any-segment match)
 *   2. plan-mode hard stop for mutating tools
 *   3. dangerous-command backstop (shell)
 *   4. trusted rules and temporary/category grants
 *   5. ask rules and remaining permission modes
 *   6. secure default: ask
 *
 * A denial is never an exception: it becomes a tool result carrying the
 * reason, so the model can adjust and continue.
 */

import { resolve } from 'node:path';
import { realPathOf } from '../tools/workspace-guard.js';
import {
  commandAllowedBy,
  commandMatchesAny,
  dangerousCommandCheck,
  hasAmbiguousShellSyntax,
  hasInjection,
  hasRedirection,
  segmentMatches,
  splitCommand,
  toolClass,
  type PermissionMode,
  type PermissionRule,
} from './rules.js';

export type PermissionDecision =
  | { action: 'allow'; reason?: string }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string };

export interface PermissionCheckInput {
  tool: string;
  /** structured input of the tool call, for context */
  input: unknown;
  /** for shell: the command; for file tools: the target path as given */
  subject: string;
  /** multi-target tools (apply_patch) list EVERY touched path here so deny
   *  rules cannot be dodged by bundling files into one patch */
  subjects?: string[];
  /** working directory — used to normalize relative paths for file rules */
  cwd: string;
}

function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  if (rule.tool === '*' || rule.tool === toolName) return true;
  return rule.tool === toolClass(toolName);
}

function ruleMatchesSubject(rule: PermissionRule, input: PermissionCheckInput, subject: string, allowSemantics: boolean): boolean {
  if (!rule.pattern || rule.pattern === '*') return true;
  if (toolClass(input.tool) === 'shell' || rule.tool === 'shell') {
    return allowSemantics
      ? commandAllowedBy(rule.pattern, subject)
      : commandMatchesAny(rule.pattern, subject);
  }
  const subjectLex = normalizePath(input.cwd, subject);
  const patternLex = normalizePath(input.cwd, rule.pattern);
  const subjectReal = normalizeRealPath(input.cwd, subject);
  const patternReal = normalizeRealPath(input.cwd, rule.pattern);
  if (allowSemantics) {
    // Allow rules NEVER match against raw unnormalized `..` strings (`src/../package.json`),
    // and anchor relative patterns to workspace root instead of matching arbitrary subdirectories.
    return (
      globMatchAnchored(patternReal, subjectReal) ||
      globMatchAnchored(stripDrive(patternReal), stripDrive(subjectReal))
    );
  }
  // Deny/ask rules check BOTH lexical path and resolved symlink target so neither side evades a block.
  const collapsedSubject = subject.replace(/\\/g, '/');
  return (
    (!collapsedSubject.split('/').includes('..') && globMatch(rule.pattern, collapsedSubject)) ||
    globMatchAnchored(patternLex, subjectLex) ||
    globMatchAnchored(stripDrive(patternLex), stripDrive(subjectLex)) ||
    globMatchAnchored(patternReal, subjectReal) ||
    globMatchAnchored(stripDrive(patternReal), stripDrive(subjectReal)) ||
    (!rule.pattern.includes('/') && !rule.pattern.includes('\\') && (globMatch(rule.pattern, subjectLex) || globMatch(rule.pattern, subjectReal)))
  );
}

/** Resolve via path.resolve so `.`, `..`, `./` and drive letters collapse. */
function normalizePath(cwd: string, p: string): string {
  return resolve(cwd, p).replace(/\\/g, '/');
}

function normalizeRealPath(cwd: string, p: string): string {
  // Preserve glob wildcards by resolving the static directory prefix with realPathOf.
  const slash = p.replace(/\\/g, '/');
  const wildIdx = slash.search(/[*?]/);
  if (wildIdx === -1) return realPathOf(resolve(cwd, p)).replace(/\\/g, '/');
  const prefixEnd = slash.lastIndexOf('/', wildIdx);
  const staticPart = prefixEnd > 0 ? slash.slice(0, prefixEnd) : prefixEnd === 0 ? '/' : '.';
  const rest = prefixEnd >= 0 ? slash.slice(prefixEnd + 1) : slash;
  const resolvedBase = realPathOf(resolve(cwd, staticPart)).replace(/\\/g, '/').replace(/\/+$/, '');
  return `${resolvedBase}/${rest}`;
}

function stripDrive(p: string): string {
  return p.replace(/^[a-zA-Z]:/, '');
}

/** Minimal glob: `**` crosses separators, `*`/`?` do not. */
export function globMatch(pattern: string, path: string): boolean {
  const re = globToRegExp(pattern, false);
  return re.test(path);
}

function globMatchAnchored(pattern: string, path: string): boolean {
  const re = globToRegExp(pattern, true);
  return re.test(path);
}

function globToRegExp(pattern: string, fullAnchor = false): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  let anchored = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += anchored ? '.*' : '(?:.*/)?';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    anchored = true;
  }
  return new RegExp(`${fullAnchor ? '^' : '(?:^|/)'}${out}$`, 'i');
}

export class PermissionService {
  private sessionRules: PermissionRule[] = [];
  private modeValue: PermissionMode = 'default';
  private readonly listeners = new Set<() => void>();
  private readonly categoryGrants = new Set<string>();

  constructor(
    private denyRules: PermissionRule[],
    private allowRules: PermissionRule[],
    private askRules: PermissionRule[],
  ) {}

  get mode(): PermissionMode {
    return this.modeValue;
  }

  setMode(mode: PermissionMode): void {
    this.modeValue = mode;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  reconfigure(deny: PermissionRule[], allow: PermissionRule[], ask: PermissionRule[], mode: PermissionMode): void {
    this.denyRules = deny; this.allowRules = allow; this.askRules = ask;
    this.modeValue = mode;
    this.changed();
  }

  allowCategory(tool: string): void { this.categoryGrants.add(toolClass(tool)); this.changed(); }

  addSessionRule(rule: string): void {
    this.sessionRules.push({ ...parseRuleSafe(rule), source: 'session' });
    this.changed();
  }

  resetSessionRules(): void {
    this.sessionRules = [];
    this.categoryGrants.clear();
    this.changed();
  }

  /** A child grant can never override the owner's live deny/ask rules or readonly mode. */
  restriction(input: PermissionCheckInput): string | undefined {
    const subjects = input.subjects?.length ? input.subjects : [input.subject];
    if (this.modeValue === 'plan' && toolClass(input.tool) !== 'read' && input.tool !== 'plan' && input.tool !== 'ask_user') return '父对话已切换到只读权限';
    if (this.modeValue === 'dontAsk' && toolClass(input.tool) !== 'read' && input.tool !== 'plan') return '父对话禁止无人值守写入';
    for (const rule of [...this.denyRules, ...this.askRules]) if (ruleMatchesTool(rule, input.tool) && subjects.some(subject => ruleMatchesSubject(rule, input, subject, false))) return '父对话的拒绝或单次审批规则不允许子任务自动执行';
    return undefined;
  }

  /**
   * Union coverage: every segment of the command must match at least one
   * allow rule. A single rule never vouches for a whole compound command
   * unless it covers every segment itself.
   */
  private shellFullyCovered(rules: PermissionRule[], command: string, toolName = 'shell'): boolean {
    if (hasInjection(command) || hasAmbiguousShellSyntax(command)) return false;
    const segments = splitCommand(command);
    if (!segments.length) return false;
    if (segments.some((seg) => hasRedirection(seg))) return false;
    const patterns = rules
      .filter((r) => ruleMatchesTool(r, toolName))
      .map((r) => r.pattern ?? '*');
    if (!patterns.length) return false;
    return segments.every((seg) => patterns.some((p) => segmentMatches(p, seg, false)));
  }

  check(input: PermissionCheckInput): PermissionDecision {
    const cls = toolClass(input.tool);
    const subjects = input.subjects?.length ? input.subjects : [input.subject];

    // 1. deny rules — any-segment semantics, across EVERY touched path
    for (const rule of this.denyRules) {
      if (!ruleMatchesTool(rule, input.tool)) continue;
      for (const subject of subjects) {
        if (ruleMatchesSubject(rule, input, subject, false)) {
          return { action: 'deny', reason: `Denied by rule \`${rule.tool}${rule.pattern ? `:${rule.pattern}` : ''}\`` };
        }
      }
    }

    // A live switch to plan mode immediately blocks future side effects,
    // including previously remembered approvals.
    const isExplorerDelegate = input.tool === 'delegate_task' && (input.input as { role?: string } | undefined)?.role === 'explorer';
    if (this.modeValue === 'plan' && cls !== 'read' && !isExplorerDelegate && input.tool !== 'plan' && input.tool !== 'ask_user') {
      return { action: 'deny', reason: 'Plan mode is active — only read-only tools may run.' };
    }
    // Read-only/unattended modes cannot be relaxed by approving a dangerous call.
    if (cls === 'shell') {
      const danger = subjects.map(dangerousCommandCheck).find(d => d.dangerous);
      if (danger) return this.modeValue === 'dontAsk'
        ? { action: 'deny', reason: `Dangerous command (${danger.why}) — unattended execution is forbidden` }
        : { action: 'ask', reason: `Dangerous command (${danger.why}) — needs explicit approval` };
    }
    // Category approval is scoped to this conversation. Explicit ask/deny and
    // dangerous commands stay authoritative over category grants.
    const explicitlyAsked = this.askRules.some(rule => ruleMatchesTool(rule, input.tool) && subjects.some(subject => ruleMatchesSubject(rule, input, subject, false)));
    if (!explicitlyAsked && this.categoryGrants.has(cls) && cls !== 'other') return { action: 'allow', reason: '本对话已允许同类操作' };
    // 2. trusted allow rules — shell requires union coverage of all segments;
    //    multi-file tools require EVERY path to be covered
    const allAllow = [...this.allowRules, ...this.sessionRules];
    if (cls === 'shell') {
      const shellRules = allAllow.filter((r) => ruleMatchesTool(r, input.tool));
      if (shellRules.length && subjects.every((subj) => this.shellFullyCovered(shellRules, subj, input.tool))) {
        return { action: 'allow', reason: 'allowed by rules' };
      }
    } else {
      for (const rule of allAllow) {
        if (!ruleMatchesTool(rule, input.tool)) continue;
        if (subjects.every((subject) => ruleMatchesSubject(rule, input, subject, true))) {
          return { action: 'allow', reason: 'allowed by rule' };
        }
      }
    }

    // 4. ask rules
    for (const rule of this.askRules) {
      if (!ruleMatchesTool(rule, input.tool)) continue;
      for (const subject of subjects) {
        if (ruleMatchesSubject(rule, input, subject, false)) {
          return { action: 'ask', reason: `Matched ask rule \`${rule.tool}${rule.pattern ? `:${rule.pattern}` : ''}\`` };
        }
      }
    }

    // Internal planning has no external side effects. ask_user already asks
    // the user directly; approving the question first would be redundant.
    // Subagent delegation enforces parent permissions on every child tool call.
    if (input.tool === 'plan') return { action: 'allow', reason: 'internal task plan' };
    if (input.tool === 'ask_user' && this.modeValue !== 'dontAsk') return { action: 'allow', reason: 'direct user question' };
    if (isExplorerDelegate) return { action: 'allow', reason: 'read-only explorer subagent' };
    if (input.tool === 'delegate_task' && this.modeValue !== 'plan' && this.modeValue !== 'dontAsk') {
      return { action: 'allow', reason: 'subagent inherits parent permission checks on all inner tool calls' };
    }

    // 5. permission mode
    switch (this.modeValue) {
      case 'plan':
        if (cls === 'read') return { action: 'allow' };
        return {
          action: 'deny',
          reason: 'Plan mode is active — only read-only tools may run. Present a plan and ask the user to switch modes.',
        };
      case 'acceptEdits':
        if (cls === 'read' || cls === 'edit') return { action: 'allow' };
        if (cls === 'shell') return { action: 'ask', reason: 'acceptEdits mode auto-approves edits, but not shell commands' };
        return { action: 'ask', reason: 'acceptEdits mode' };
      case 'bypassPermissions':
        if (cls === 'shell') {
          const danger = subjects.map(dangerousCommandCheck).find((d) => d.dangerous);
          if (danger) {
            return { action: 'ask', reason: `bypassPermissions mode still asks for dangerous commands (${danger.why})` };
          }
        }
        return { action: 'allow', reason: 'bypassPermissions mode' };
      case 'dontAsk':
        // Unattended mode: never prompt. Only what is pre-approved or
        // read-only may run; everything else is denied with guidance.
        if (cls === 'read') return { action: 'allow', reason: 'read-only tool' };
        return {
          action: 'deny',
          reason:
            'dontAsk mode is active (no interactive approval available): this call was not pre-approved by an allow rule. ' +
            'Add it to permissions.allow in settings, or run with a different permission mode.',
        };
      case 'default':
      default:
        break;
    }

    // 6. secure default
    if (cls === 'read') return { action: 'allow', reason: 'read-only tool' };
    return {
      action: 'ask',
      reason: `No rule allows \`${input.tool}\` — the secure default is to ask`,
    };
  }
}

function parseRuleSafe(raw: string): PermissionRule {
  const colon = raw.indexOf(':');
  if (colon === -1) return { tool: raw.trim(), source: 'session' };
  return { tool: raw.slice(0, colon).trim(), pattern: raw.slice(colon + 1).trim(), source: 'session' };
}
