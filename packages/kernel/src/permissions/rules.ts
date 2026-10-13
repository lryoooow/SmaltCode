/**
 * Permission rules and matching.
 *
 * Rule strings look like:
 *   `read`                  — the whole read tool
 *   `edit`                  — write / apply_patch tools
 *   `shell`                 — every shell command
 *   `shell:git status`      — shell commands starting with `git status`
 *   `edit:src/**`           — edits under src/ (glob, relative to cwd)
 *   `read:package.json`
 *
 * Sources: 'user' (~/.smalt/settings.json), 'project' (.smalt/settings.json),
 * 'session' (remembered for this session via an approval), 'cli' (flags).
 *
 * SECURITY: a compound command (`a && b`, `a; b`, `a | b`, newline-separated)
 * is only allowed by a shell rule when EVERY segment individually matches.
 * Deny/ask rules match when ANY segment matches. Commands containing command
 * substitution (`$(...)`, backticks) or process substitution never match an
 * allow rule — they must be approved explicitly.
 */

export type RuleSource = 'user' | 'project' | 'session' | 'cli';

export interface PermissionRule {
  /** 'shell' | 'edit' | 'read' | '*' or a concrete tool name */
  tool: string;
  /** shell: command-prefix tokens; files: glob; empty = whole tool */
  pattern?: string;
  source: RuleSource;
}

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk';

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
];

/** Tool classes used by rule matching. */
export function toolClass(toolName: string): 'shell' | 'edit' | 'read' | 'other' {
  switch (toolName) {
    case 'shell':
      return 'shell';
    case 'write':
    case 'apply_patch':
      return 'edit';
    case 'read':
    case 'glob':
    case 'grep':
      return 'read';
    default:
      return 'other';
  }
}

export function parseRule(raw: string, source: RuleSource): PermissionRule {
  const colon = raw.indexOf(':');
  if (colon === -1) return { tool: raw.trim(), source };
  return {
    tool: raw.slice(0, colon).trim(),
    pattern: raw.slice(colon + 1).trim(),
    source,
  };
}

/** Token-prefix match for one simple command: `git status` matches `git status --short`. */
export function segmentMatches(pattern: string, segment: string): boolean {
  const pat = pattern.trim().replace(/\s+/g, ' ');
  const cmd = segment.trim().replace(/\s+/g, ' ');
  if (!pat || pat === '*') return true;
  if (pat === cmd) return true;
  return cmd.startsWith(`${pat} `);
}

/**
 * Quote-aware command tokenizer: splits on separators && || & | ; and
 * newlines while leaving quoted spans intact. Single `&` counts as a
 * separator (cmd.exe chaining, bash backgrounding) — skipping it let
 * `echo hi & rm -rf x` ride an `allow: echo` rule.
 */
export function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Structures that can smuggle arbitrary code behind an innocuous prefix. */
export function hasInjection(command: string): boolean {
  return (
    command.includes('$(') ||
    command.includes('`') ||
    command.includes('<(') ||
    command.includes('>(')
  );
}

/**
 * Redirections turn an allowed reader/command into an arbitrary file WRITER
 * (`echo owned > hello.txt`). An allow rule never covers them — they must
 * pass an explicit approval.
 */
export function hasRedirection(segment: string): boolean {
  return /(^|[^\\])>{1,2}\s*\S|(^|[^\\])2>\s*\S|(^|[=\s])<\s*\S|\d>>\s*\S/.test(segment);
}

/**
 * ALLOW semantics — every segment of the command must match the pattern.
 * Returns false for empty commands, injection constructs, redirections, or
 * any non-matching segment.
 */
export function commandAllowedBy(pattern: string, command: string): boolean {
  if (hasInjection(command)) return false;
  const segments = splitCommand(command);
  if (!segments.length) return false;
  if (segments.some((seg) => hasRedirection(seg))) return false;
  return segments.every((seg) => segmentMatches(pattern, seg));
}

/**
 * DENY/ASK semantics — matching any single segment is enough.
 */
export function commandMatchesAny(pattern: string, command: string): boolean {
  const segments = splitCommand(command);
  if (!segments.length) return false;
  return segments.some((seg) => segmentMatches(pattern, seg));
}

/**
 * Patterns that are structurally unsafe regardless of rules — they either wipe
 * system paths, reformat disks, fork-bomb, or pipe remote scripts into a shell.
 * Kept deliberately short and conservative; this is a backstop, not a sandbox.
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b.*\s(\/|~|\$HOME|\/home|\/Users|\/etc|\/var|\/usr)(\s|\/?$)/i, why: 'recursive delete targeting a system or home root' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'filesystem format' },
  { re: /\bdd\b[^|]*\bof=\/dev\//i, why: 'raw write to a device' },
  { re: /:\(\)\s*\{.*\};\s*:/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt)\b/i, why: 'system power control' },
  { re: /\bformat\s+[a-z]:/i, why: 'disk format' },
  { re: /\breg\s+delete\s+(HKLM|HKEY_LOCAL_MACHINE)/i, why: 'machine registry delete' },
  { re: /\bbcdedit\b/i, why: 'boot configuration edit' },
  { re: /\b(curl|wget|powershell|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: 'piping a remote script into a shell' },
];

/** Dangerous check runs on the whole command AND per segment: patterns that
 * span separators (pipe-to-shell) need the full text; per-segment checks stop
 * chaining dodges. */
export function dangerousCommandCheck(command: string): { dangerous: true; why: string } | { dangerous: false } {
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(command)) return { dangerous: true, why: `${why} (command: ${command.slice(0, 80)})` };
  }
  for (const segment of splitCommand(command)) {
    for (const { re, why } of DANGEROUS_PATTERNS) {
      if (re.test(segment)) return { dangerous: true, why: `${why} (segment: ${segment.slice(0, 80)})` };
    }
  }
  return { dangerous: false };
}
