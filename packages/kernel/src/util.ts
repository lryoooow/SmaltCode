/** Small shared utilities. */

let counter = 0;

export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}_${time}${counter.toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(s: string, max: number, suffix = '\n… [truncated]'): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + suffix;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Uniform-diff style preview between two line arrays. */
export function unifiedDiff(
  path: string,
  before: string[],
  after: string[],
  context = 3,
): string {
  // find first/last differing indices
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const ctxStart = Math.max(0, start - context);
  const ctxEndB = Math.min(before.length, endB + context);
  const ctxEndA = Math.min(after.length, endA + context);

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`, `@@ -${ctxStart + 1},${ctxEndB - ctxStart} +${ctxStart + 1},${ctxEndA - ctxStart} @@`];
  for (let i = ctxStart; i < start; i++) lines.push(` ${before[i]}`);
  for (let i = start; i < endB; i++) lines.push(`-${before[i]}`);
  for (let i = start; i < endA; i++) lines.push(`+${after[i]}`);
  for (let i = endB; i < ctxEndB; i++) lines.push(` ${before[i]}`);
  return lines.join('\n');
}
