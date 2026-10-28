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
    case 'container_exec':
    case 'container_process_stop':
    case 'ssh_exec':
    case 'ssh_process_stop':
    case 'process_stop':
      return 'shell';
    case 'resource_write':
    case 'write':
    case 'container_write':
    case 'ssh_write':
    case 'apply_patch':
      return 'edit';
    case 'task_checkpoint':
    case 'process_read':
    case 'container_read':
    case 'container_process_read':
    case 'ssh_read':
    case 'ssh_process_read':
    case 'ssh_connections':
    case 'resource_list':
    case 'resource_read':
    case 'resource_search':
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
    // Descriptor duplication is part of the current command, not chaining.
    if (ch === '&' && /[<>]$/.test(current) && /[\d-]/.test(command[i + 1] ?? '')) { current += ch; continue; }
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
  const unquoted = segment.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '');
  const withoutDescriptors = unquoted.replace(/\d*[<>]&(?:\d+|-)(?=\s|$)/g, '');
  return /[<>]/.test(withoutDescriptors);
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
export function commandMatchesAny(pattern: string, command: string, depth = 0): boolean {
  if (depth > 8) return true; // ambiguous nested interpreters never bypass a deny
  const segments = splitCommand(command);
  if (!segments.length) return false;
  return segments.some((seg) => segmentMatches(pattern, seg) || wrappedCommands(seg).some(inner => commandMatchesAny(pattern, inner, depth + 1)));
}

/** Inspect common shell wrappers for deny rules; never use this to grant consent. */
function wrappedCommands(command: string): string[] {
  const match = /^(?:(?:sudo|env)\s+)?(?:[\w:/\\.-]*[\\/])?(?:ba?sh|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[^\s]+\s+)*?(?:-c|-command|\/c)\s+([\s\S]+)$/i.exec(command.trim());
  if (!match) return [];
  const body = match[1]!.trim();
  const inner = /^(["'])([\s\S]*)\1$/.exec(body)?.[2] ?? body;
  // Each recursion consumes a wrapper, bounded by the original input length.
  return inner.length < command.length ? [inner] : [];
}

function destructiveRoot(command: string): boolean {
  const words = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map(word => word.replace(/^(["'])([\s\S]*)\1$/, '$2')) ?? [];
  const name = (words[0] ?? '').split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, '');
  if (name === 'sudo') return destructiveRoot(words.slice(1).join(' '));
  const remove = name === 'rm', windows = ['remove-item', 'ri', 'rd', 'rmdir', 'del', 'erase'].includes(name ?? '');
  if (!remove && !windows) return false;
  const recursive = windows || words.slice(1).some(word => /^--recursive(?:=|$)/i.test(word) || /^-[^-]*r/i.test(word));
  if (!recursive) return false;
  return words.slice(1).filter(word => !word.startsWith('-') && !/^\/[sq]$/i.test(word)).some(target => {
    const value = target.replace(/\\/g, '/').replace(/\/+$/, '');
    return value === '' || /^(?:~|\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|%(?:USERPROFILE|HOMEDRIVE|SYSTEMROOT)%)(?:\/|$)/i.test(value)
      || /^\/(?:[*?]|(?:etc|var|usr|bin|sbin|boot|dev|home|Users)(?:\/|$))/.test(value)
      || /^[a-z]:(?:\/?[*?])?$/i.test(value)
      || /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(value)
      || /^[a-z]:\/users(?:\/[^/*?]+)?(?:\/[*?])?$/i.test(value);
  });
}

/**
 * Patterns that are structurally unsafe regardless of rules — they either wipe
 * system paths, reformat disks, fork-bomb, or pipe remote scripts into a shell.
 * Kept deliberately short and conservative; this is a backstop, not a sandbox.
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:enc|encodedcommand)\b/i, why: 'encoded shell command' },
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
export function dangerousCommandCheck(command: string, depth = 0): { dangerous: true; why: string } | { dangerous: false } {
  if (depth > 8) return { dangerous: true, why: 'deeply nested shell interpreters require review' };
  for (const segment of splitCommand(command)) {
    if (destructiveRoot(segment) || wrappedCommands(segment).some(inner => dangerousCommandCheck(inner, depth + 1).dangerous)) return { dangerous: true, why: 'destructive command targeting a system or home path' };
  }
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
