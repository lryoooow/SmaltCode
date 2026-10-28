import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { desktopAppId, desktopTestSwitches } from '../src/main/identity';

// A comment containing a flag is not an argument passed to the process.
function withoutPythonComment(line: string): string {
  let quote = '', escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') return line.slice(0, i);
  }
  return line;
}

const scripts = resolve('scripts');
const launches = readdirSync(scripts)
  .filter(name => /^test-desktop-.*\.py$/.test(name) || name === '_desktop_review_harness.py')
  .sort()
  .flatMap(file => readFileSync(join(scripts, file), 'utf8').split(/\r?\n/).flatMap((raw, index) => {
    const command = withoutPythonComment(raw);
    return /\bsubprocess\.Popen\s*\(/.test(command) && /(['"])--development-preview\1/.test(command)
      ? [{ file, line: index + 1, command }]
      : [];
  }));

describe('GUI test launcher identity isolation contract', () => {
  it('inspects direct launches and the shared desktop harness', () => {
    expect(launches.length).toBeGreaterThan(0);
    expect(launches.some(value => value.file === '_desktop_review_harness.py')).toBe(true);
  });

  it.each(launches)('$file:$line never launches under the real development taskbar group', ({ file, line, command }) => {
    expect(/(['"])(?:--identity-test|--ui-test)\1/.test(command), `${file}:${line} must pass an explicit isolated GUI test flag`).toBe(true);
  });

  it('recognizes identity-test and keeps its AUMID separate from ordinary preview and installed windows', () => {
    expect(desktopTestSwitches).toContain('identity-test');
    const testing = desktopTestSwitches.some(flag => flag === 'identity-test');
    const normalPreview = desktopAppId(false, false, true);
    const installed = desktopAppId(true, false);
    for (const packaged of [false, true]) {
      const testId = desktopAppId(packaged, testing, true);
      expect(testId).toBe('app.smaltcode.desktop.test');
      expect(testId).not.toBe(normalPreview);
      expect(testId).not.toBe(installed);
    }
  });
});
