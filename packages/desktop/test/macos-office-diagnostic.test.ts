import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnoseMacOffice } from '../src/main/macos-office-diagnostic';

function fixture() {
  const directory = mkdtempSync(resolve('.qa-work/mac-office-diagnostic-')), app = join(directory, '中文 LibreOffice.app');
  for (const name of ['MacOS', 'Resources']) mkdirSync(join(app, 'Contents', name), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), 'fixture'); writeFileSync(join(app, 'Contents', 'MacOS', 'soffice'), 'never execute');
  return { directory, app };
}
describe('read-only Mac Office engine diagnostic', () => {
  it('checks only fixed system tools and never reports editing ready or runs the selected executable', async () => {
    const { app } = fixture(); writeFileSync(join(app, 'Contents', 'Resources', 'python'), 'never execute');
    const run = vi.fn(async (tool: string) => tool.endsWith('plutil') ? 'soffice' : '');
    const report = await diagnoseMacOffice(app, { platform: 'darwin', run });
    expect(report.ready).toBe(false); expect(report.checks.map(c => [c.id, c.passed])).toEqual([['identity', true], ['signature', true], ['gatekeeper', true], ['python', true], ['roundtrip', false]]);
    expect(run.mock.calls.map(c => c[0])).toEqual(['/usr/bin/plutil', '/usr/bin/codesign', '/usr/sbin/spctl']);
  });
  it('keeps a rejected signature, missing Python and unverified save chain visibly unavailable', async () => {
    const { app } = fixture(); const run = vi.fn(async (tool: string) => { if (!tool.endsWith('plutil')) throw Error('untrusted payload'); return 'soffice'; });
    const report = await diagnoseMacOffice(app, { platform: 'darwin', run });
    expect(report.ready).toBe(false); expect(report.checks.filter(c => c.passed).map(c => c.id)).toEqual(['identity']);
    expect(JSON.stringify(report)).not.toContain('untrusted payload');
  });
  it('rejects foreign platforms, invalid bundles and executable paths escaping the selected bundle', async () => {
    const { app, directory } = fixture(), run = vi.fn();
    await expect(diagnoseMacOffice(app, { platform: 'win32', run })).rejects.toThrow('macOS');
    await expect(diagnoseMacOffice(directory, { platform: 'darwin', run })).rejects.toThrow('应用包');
    const escaped = join(directory, 'Escaped.app'); mkdirSync(escaped); symlinkSync(join(app, 'Contents'), join(escaped, 'Contents'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(diagnoseMacOffice(escaped, { platform: 'darwin', run })).rejects.toThrow('包外'); expect(run).not.toHaveBeenCalled();
  });
  it('stops inspection after cancellation and does not continue to the next system tool', async () => {
    const { app } = fixture(), cancel = new AbortController();
    const run = vi.fn(async () => { cancel.abort(); return 'soffice'; });
    await expect(diagnoseMacOffice(app, { platform: 'darwin', run, signal: cancel.signal })).rejects.toThrow('取消'); expect(run).toHaveBeenCalledOnce();
  });
  it('does not treat an application with a different main executable as LibreOffice', async () => {
    const { app } = fixture(), run = vi.fn(async () => 'different-program');
    const report = await diagnoseMacOffice(app, { platform: 'darwin', run });
    expect(report.checks[0].passed).toBe(false); expect(run).toHaveBeenCalledOnce(); expect(report.ready).toBe(false);
  });
});
