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

/** Keep diagnostics from both ends; never feed unbounded tool output to a model. */
export function budgetToolOutput(text: string, limit = 24000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 3), marker = '\n… [中间输出已省略，请按范围读取详情] …\n';
  return text.slice(0, head) + marker + text.slice(-(limit - head - marker.length));
}

export function diffPreview(diff: string): string { return budgetToolOutput(diff.split('\n').slice(0, 24).join('\n'), 3000) + (diff.split('\n').length > 24 ? '\n[完整差异请在文件审查中查看]' : ''); }

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
  // Trim common edges first, then Myers within a bounded edit-distance budget.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  if (start === before.length && start === after.length) return '';
  const a = before.slice(start, endB), b = after.slice(start, endA);
  type Op = { kind: ' ' | '+' | '-'; text: string };
  const frontier = new Map<number, number>([[1, 0]]), trace: Map<number, number>[] = [];
  let middle: Op[] | undefined, work = 0;
  search: for (let distance = 0; distance <= Math.min(a.length + b.length, 1000); distance++) {
    trace.push(new Map(frontier));
    for (let k = -distance; k <= distance; k += 2) {
      if (++work > 2_000_000) break search;
      let x = k === -distance || k !== distance && (frontier.get(k - 1) ?? -Infinity) < (frontier.get(k + 1) ?? -Infinity) ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(k, x);
      if (x < a.length || y < b.length) continue;
      const reversed: Op[] = [];
      for (let d = distance; d >= 0; d--) {
        const previous = trace[d]!, diagonal = x - y;
        const previousK = diagonal === -d || diagonal !== d && (previous.get(diagonal - 1) ?? -Infinity) < (previous.get(diagonal + 1) ?? -Infinity) ? diagonal + 1 : diagonal - 1;
        const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
        while (x > previousX && y > previousY) { reversed.push({ kind: ' ', text: a[--x]! }); y--; }
        if (!d) break;
        if (x === previousX) reversed.push({ kind: '+', text: b[--y]! });
        else reversed.push({ kind: '-', text: a[--x]! });
      }
      middle = reversed.reverse(); break search;
    }
  }
  middle ??= [...a.map(text => ({ kind: '-' as const, text })), ...b.map(text => ({ kind: '+' as const, text }))];
  const ops: Op[] = [...before.slice(0, start).map(text => ({ kind: ' ' as const, text })), ...middle, ...before.slice(endB).map(text => ({ kind: ' ' as const, text }))];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < ops.length; i++) if (ops[i]!.kind !== ' ') {
    const from = Math.max(0, i - context), to = Math.min(ops.length, i + context + 1), previous = ranges.at(-1);
    if (previous && previous.end >= from) previous.end = to; else ranges.push({ start: from, end: to });
  }
  const oldAt = [0], newAt = [0];
  for (const op of ops) { oldAt.push(oldAt.at(-1)! + Number(op.kind !== '+')); newAt.push(newAt.at(-1)! + Number(op.kind !== '-')); }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const range of ranges) {
    const oldCount = oldAt[range.end]! - oldAt[range.start]!, newCount = newAt[range.end]! - newAt[range.start]!;
    lines.push(`@@ -${oldAt[range.start]! + Number(oldCount > 0)},${oldCount} +${newAt[range.start]! + Number(newCount > 0)},${newCount} @@`);
    for (const op of ops.slice(range.start, range.end)) lines.push(op.kind + op.text);
  }
  return lines.join('\n');
}
