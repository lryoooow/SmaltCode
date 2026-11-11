/**
 * Fast, zero-execution post-edit syntax diagnostics (< 1 ms, in-process).
 *
 * Catches malformed JSON, broken JS/MJS/CJS syntax (compiled via `vm.Script`
 * without executing any code), accidental Git merge conflict markers, and
 * unbalanced structural delimiters in TypeScript/TSX files immediately on
 * `write` / `apply_patch` so the agent can self-repair in one step.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Script } from 'node:vm';

const MAX_DIAG_BYTES = 512 * 1024;

export function checkPostEditDiagnostics(absPath: string, displayPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    const st = statSync(absPath);
    if (!st.isFile() || st.size === 0 || st.size > MAX_DIAG_BYTES) return null;
    const content = readFileSync(absPath, 'utf8');
    const issues: string[] = [];

    // 1. Leftover git conflict markers in code/config files
    const ext = extname(absPath).toLowerCase();
    if (!['.md', '.txt', '.patch', '.diff'].includes(ext)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/^(?:<{7}\s|={7}$|>{7}\s)/.test(lines[i]!)) {
          issues.push(`${displayPath}:${i + 1}: unresolved merge conflict marker (${lines[i]!.slice(0, 7)})`);
          break;
        }
      }
    }

    // 2. JSON strict syntax validation
    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch (err) {
        issues.push(`${displayPath}: JSON syntax error — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Pure JS / CJS syntax compilation check (never executes code!)
    if (ext === '.cjs' || (ext === '.js' && !/^\s*(?:import|export)\b/m.test(content))) {
      try {
        new Script(content, { filename: displayPath });
      } catch (err) {
        if (err instanceof SyntaxError) {
          const stackLine = err.stack?.split('\n').slice(0, 3).join(' | ') ?? err.message;
          issues.push(`${displayPath}: JavaScript syntax error — ${stackLine}`);
        }
      }
    }

    // 4. Lightweight brace/paren/bracket balance sanity check for TS/TSX/JS/MJS
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext) && !issues.length) {
      const balanceErr = checkDelimiterBalance(content, displayPath);
      if (balanceErr) issues.push(balanceErr);
    }

    if (!issues.length) return null;
    return `<post-edit-diagnostics>\n${issues.join('\n')}\nFix any syntax errors introduced by this edit before finishing.\n</post-edit-diagnostics>`;
  } catch {
    return null;
  }
}

function checkDelimiterBalance(source: string, displayPath: string): string | null {
  const stack: Array<{ ch: '{' | '(' | '['; line: number }> = [];
  const pairs: Record<string, '{' | '(' | '['> = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '\n') { line++; i++; continue; }
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < len && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Single / double quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '\n') return null; // bail out safely on unusual multiline/JSX edge cases
        i++;
      }
      i++;
      continue;
    }
    // Template literal or regex literal — bail out of strict delimiter balance if regex/JSX makes lexical scan ambiguous
    if (ch === '`') {
      i++;
      while (i < len && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') return null; // nested interpolation: skip heuristic false positives
        if (source[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && i > 0) {
      // Potential regex literal: skip heuristic check to ensure zero false positives
      let prevIdx = i - 1;
      while (prevIdx >= 0 && /[ \t\r\n]/.test(source[prevIdx]!)) prevIdx--;
      const prevCh = source[prevIdx] ?? '';
      if ('=([{,:;!&|?+-~^%<>'.includes(prevCh)) return null;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      stack.push({ ch, line });
    } else if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        return `${displayPath}:${line}: mismatched '${ch}'${top ? ` (opened '${top.ch}' at line ${top.line})` : ''}`;
      }
    }
    i++;
  }
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    return `${displayPath}:${unclosed.line}: unclosed '${unclosed.ch}' reaching end of file`;
  }
  return null;
}
