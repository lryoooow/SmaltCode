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
    case 'process_write':
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
    case 'activate_skill':
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
    case 'web_search':
    case 'web_fetch':
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

/** Strip leading subshell/grouping tokens and benign command wrappers for deny/ask/danger inspection. */
function unwrapSegmentPrefix(segment: string): string {
  let s = segment.trim().replace(/^[({[\s]+/, '').replace(/[\s})\]]+$/, '').trim();
  for (let i = 0; i < 6; i++) {
    const envAssign = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]*)\s+([\s\S]+)$/.exec(s);
    if (envAssign) { s = envAssign[1]!.trim(); continue; }
    const wrapper = /^(?:sudo|env|command|nohup|nice|time)\s+(?:-[^\s]+\s+)*([\s\S]+)$/i.exec(s);
    if (wrapper) { s = wrapper[1]!.trim(); continue; }
    break;
  }
  return s;
}

function singleSegmentMatches(pat: string, candidate: string): boolean {
  if (pat === candidate || candidate.startsWith(`${pat} `)) return true;
  if (pat.includes('*')) {
    const strippedTrailing = pat.replace(/(?:\s+\*)+$/, '');
    if (strippedTrailing && !strippedTrailing.includes('*')) {
      if (strippedTrailing === candidate || candidate.startsWith(`${strippedTrailing} `)) return true;
    } else {
      const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}(?:\\s|$)`).test(candidate)) return true;
    }
  }
  return false;
}

/** Token-prefix match for one simple command: `git status` or `git status *` matches `git status --short`. */
export function segmentMatches(pattern: string, segment: string, unwrap = false): boolean {
  if (typeof pattern !== 'string') return false;
  const pat = pattern.trim().replace(/\s+/g, ' ');
  const raw = segment.trim().replace(/\s+/g, ' ');
  if (!pat || pat === '*') return true;
  if (singleSegmentMatches(pat, raw)) return true;
  if (unwrap) {
    const stripped = unwrapSegmentPrefix(raw).replace(/\s+/g, ' ');
    if (singleSegmentMatches(pat, stripped)) return true;
    // Also match executable basename when segment uses full path (e.g. /usr/bin/git push vs git push)
    const firstSpace = stripped.indexOf(' ');
    const firstTok = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
    const rest = firstSpace === -1 ? '' : stripped.slice(firstSpace);
    const base = firstTok.replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1)?.replace(/\.(?:exe|cmd|bat|com)$/i, '');
    if (base && base !== firstTok) {
      const normalized = `${base}${rest}`;
      if (singleSegmentMatches(pat, normalized)) return true;
    }
  }
  return false;
}

/**
 * Quote-aware command tokenizer: splits on separators && || & | ; and
 * newlines while leaving quoted spans intact, respecting POSIX backslash
 * escapes (`\"`, `\'`, `\\`) outside single quotes.
 */
export function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\' || command[i + 1] === '$' || command[i + 1] === '`')) {
        current += ch + command[i + 1]!;
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    // Outside quotes: backslash before quote/operator escapes the character in POSIX sh/bash
    if (ch === '\\' && i + 1 < command.length && /["'\\;&|()<> \t]/.test(command[i + 1]!)) {
      current += ch + command[i + 1]!;
      i++;
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

/** True when unclosed quotes, escaped quotes, or unquoted subshell/brace groups make shell parsing ambiguous across bash/cmd/pwsh. */
export function hasAmbiguousShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === '\\' && command[i + 1] === '"') return true;
      if (ch === '\\' && command[i + 1] === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && /["'\\;&|()<>]/.test(command[i + 1] ?? '')) return true;
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return true;
  }
  return quote !== null;
}

/** Structures that can smuggle arbitrary code behind an innocuous prefix. */
export function hasInjection(command: string): boolean {
  return (
    command.includes('$(') ||
    command.includes('`') ||
    command.includes('<(') ||
    command.includes('>(') ||
    /@\s*\(/.test(command) ||
    /\$\{[^}]*[:?+=]/.test(command)
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
 * Returns false for empty commands, injection constructs, ambiguous escapes/subshells,
 * redirections, or any non-matching segment.
 */
export function commandAllowedBy(pattern: string, command: string): boolean {
  if (hasInjection(command) || hasAmbiguousShellSyntax(command)) return false;
  const segments = splitCommand(command);
  if (!segments.length) return false;
  if (segments.some((seg) => hasRedirection(seg))) return false;
  return segments.every((seg) => segmentMatches(pattern, seg, false));
}

/**
 * DENY/ASK semantics — matching any single segment is enough.
 */
export function commandMatchesAny(pattern: string, command: string, depth = 0): boolean {
  if (depth > 8) return true; // ambiguous nested interpreters never bypass a deny
  const segments = splitCommand(command);
  if (!segments.length) return false;
  return segments.some((seg) => segmentMatches(pattern, seg, true) || wrappedCommands(seg).some(inner => commandMatchesAny(pattern, inner, depth + 1)));
}

/** Inspect common shell wrappers for deny rules; never use this to grant consent. */
function wrappedCommands(command: string): string[] {
  const stripped = unwrapSegmentPrefix(command);
  const match = /^(?:[\w:/\\.-]*[\\/])?(?:ba?sh|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[^\s]+\s+)*?(?:-c|-command|\/c)\s+([\s\S]+)$/i.exec(stripped);
  if (!match) return stripped !== command.trim() && stripped.length < command.length ? [stripped] : [];
  const body = match[1]!.trim();
  const inner = /^(["'])([\s\S]*)\1$/.exec(body)?.[2] ?? body;
  // Each recursion consumes a wrapper, bounded by the original input length.
  return inner.length < command.length ? [inner] : [];
}

function destructiveRoot(command: string): boolean {
  const stripped = unwrapSegmentPrefix(command);
  const words = stripped.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map(word => word.replace(/^(["'])([\s\S]*)\1$/, '$2')) ?? [];
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
  { re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:e|ec|enc|encodedcommand)\b/i, why: 'encoded shell command' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'filesystem format' },
  { re: /\bdd\b[^|]*\bof=\/dev\//i, why: 'raw write to a device' },
  { re: /:\(\)\s*\{.*\};\s*:/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt)\b/i, why: 'system power control' },
  { re: /\bformat\s+[a-z]:/i, why: 'disk format' },
  { re: /\breg\s+(?:delete|add)\s+(?:HKLM|HKEY_LOCAL_MACHINE)/i, why: 'machine registry modification' },
  { re: /\breg\s+add\b[^\n]*\\CurrentVersion\\Run\b/i, why: 'autorun registry persistence' },
  { re: /\bbcdedit\b/i, why: 'boot configuration edit' },
  { re: /\bvssadmin\b[^\n]*\bdelete\s+shadows\b/i, why: 'shadow copy deletion' },
  { re: /\bsc(?:\.exe)?\s+(?:delete|stop)\b/i, why: 'system service disruption' },
  { re: /\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i, why: 'UAC privilege elevation' },
  { re: /\b(curl|wget|powershell|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|;&]*\|\s*(sudo\s+)?(?:(?:ba)?sh|pwsh|powershell|iex|Invoke-Expression)\b/i, why: 'piping a remote script into a shell' },
  { re: /\b(?:iex|Invoke-Expression)\s*\(\s*(?:New-Object\s+Net\.WebClient|\(?\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b)/i, why: 'PowerShell download cradle execution' },
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
