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
import {
  commandAllowedBy,
  commandMatchesAny,
  dangerousCommandCheck,
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
  if (input.tool === 'shell' || rule.tool === 'shell') {
    return allowSemantics
      ? commandAllowedBy(rule.pattern, subject)
      : commandMatchesAny(rule.pattern, subject);
  }
  // file-ish rule: normalize both sides against cwd before comparing,
  // so `.env` rules, `..\`-style and absolute-path subjects all line up
  const subjectAbs = normalizePath(input.cwd, subject);
  const patternAbs = normalizePath(input.cwd, rule.pattern);
  return (
    globMatch(rule.pattern, subject) ||
    globMatch(patternAbs, subjectAbs) ||
    globMatch(stripDrive(patternAbs), stripDrive(subjectAbs))
  );
}

/** Resolve via path.resolve so `.`, `..`, `./` and drive letters collapse. */
function normalizePath(cwd: string, p: string): string {
  return resolve(cwd, p).replace(/\\/g, '/');
}

function stripDrive(p: string): string {
  return p.replace(/^[a-zA-Z]:/, '');
}

/** Minimal glob: `**` crosses separators, `*`/`?` do not. */
export function globMatch(pattern: string, path: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(path);
}

function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  let anchored = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        out += anchored ? '.*' : '(?:.*/)?';
        i++;
        if (p[i + 1] === '/') i++;
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
  return new RegExp(`(?:^|/)${out}$`, 'i');
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

  /**
   * Union coverage: every segment of the command must match at least one
   * allow rule. A single rule never vouches for a whole compound command
   * unless it covers every segment itself.
   */
  private shellFullyCovered(rules: PermissionRule[], command: string): boolean {
    if (hasInjection(command)) return false;
    const segments = splitCommand(command);
    if (!segments.length) return false;
    if (segments.some((seg) => hasRedirection(seg))) return false;
    const patterns = rules
      .filter((r) => r.tool === 'shell' || r.tool === '*')
      .map((r) => r.pattern ?? '*');
    if (!patterns.length) return false;
    return segments.every((seg) => patterns.some((p) => segmentMatches(p, seg)));
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
    if (this.modeValue === 'plan' && cls !== 'read' && input.tool !== 'plan' && input.tool !== 'ask_user') {
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
      if (shellRules.length && this.shellFullyCovered(shellRules, input.subject)) {
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
    if (input.tool === 'plan') return { action: 'allow', reason: 'internal task plan' };
    if (input.tool === 'ask_user' && this.modeValue !== 'dontAsk') return { action: 'allow', reason: 'direct user question' };

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
          const danger = dangerousCommandCheck(input.subject);
          if (danger.dangerous) {
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
