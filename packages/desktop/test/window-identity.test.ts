import { afterEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { desktopAppId, desktopTestSwitches, desktopWindowDetails } from '../src/main/identity';

const roots: string[] = [];
const sourceIcon = resolve('packages/desktop/assets/smalt.ico');
function fixture() {
  const root = mkdtempSync(resolve('.qa-work/window-identity-'));
  roots.push(root);
  const appPath = join(root, '源码 preview with spaces');
  mkdirSync(appPath);
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  writeFileSync(join(appPath, 'main.cjs'), 'console.log(JSON.stringify({entry:__dirname,args:process.argv.slice(2)}))');
  return { root, appPath };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const within = relative(resolve('.qa-work'), root);
    if (within.startsWith('..') || !within.startsWith('window-identity-')) throw new Error('QA cleanup escaped');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real Windows Shell identity paths and relaunch entry', () => {
  it('uses a physical EXE for the installed app, never an ICO inside the archive', () => {
    const { root } = fixture();
    const appPath = join(root, 'resources', 'app.asar');
    const details = desktopWindowDetails({ packaged: true, testing: false, developmentPreview: false, executable: process.execPath, appPath, sourceIcon: join(appPath, 'dist/main/smalt.ico') });
    expect(statSync(details.appIconPath!).isFile()).toBe(true);
    expect(realpathSync(details.appIconPath!)).toBe(realpathSync(process.execPath));
    expect(details.appIconPath).not.toContain('app.asar');
    expect(details.relaunchCommand).not.toContain('app.asar');
    expect(details.relaunchCommand).toBe('"' + process.execPath + '"');
    expect(details.appId).toBe('app.smaltcode.desktop');
    expect(details.relaunchDisplayName).toBe('SmaltCode');
  });

  it('uses the readable canonical ICO for source execution', () => {
    const { appPath } = fixture();
    const details = desktopWindowDetails({ packaged: false, testing: false, developmentPreview: true, executable: process.execPath, appPath, sourceIcon });
    expect(readFileSync(details.appIconPath!)).toEqual(readFileSync(sourceIcon));
    expect(details.appId).toBe('app.smaltcode.desktop.development');
    expect(details.relaunchDisplayName).toBe('SmaltCode 开发预览');
  });

  it('executes the source relaunch command with Unicode and spaces, preserving the application entry and preview flag', () => {
    const { appPath } = fixture();
    const details = desktopWindowDetails({ packaged: false, testing: false, developmentPreview: true, executable: process.execPath, appPath, sourceIcon });
    const actual = JSON.parse(execSync(details.relaunchCommand!, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    expect(realpathSync(actual.entry)).toBe(realpathSync(appPath));
    expect(actual.args).toEqual(['--development-preview']);
  });

  it('keeps a branded renamed Electron preview separate even if Electron reports it packaged', () => {
    const { appPath } = fixture();
    const details = desktopWindowDetails({ packaged: true, testing: false, developmentPreview: true, executable: process.execPath, appPath, sourceIcon });
    const actual = JSON.parse(execSync(details.relaunchCommand!, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    expect(realpathSync(actual.entry)).toBe(realpathSync(appPath));
    expect(details.appId).toBe('app.smaltcode.desktop.development');
    expect(readFileSync(details.appIconPath!)).toEqual(readFileSync(sourceIcon));
  });

  it('uses the branded preview EXE as its Shell icon and executes its relaunch from Unicode and space-containing paths', () => {
    const { root, appPath } = fixture();
    const runtime = join(root, '品牌 runtime with spaces');
    mkdirSync(runtime);
    const executable = join(runtime, 'SmaltCode Preview.exe');
    copyFileSync(process.execPath, executable);
    for (const packaged of [false, true]) {
      const details = desktopWindowDetails({ packaged, testing: false, developmentPreview: true, executable, appPath, sourceIcon });
      expect(statSync(details.appIconPath!).isFile()).toBe(true);
      expect(realpathSync(details.appIconPath!)).toBe(realpathSync(executable));
      expect(statSync(details.appIconPath!).size).toBe(statSync(process.execPath).size);
      expect(details.appId).toBe('app.smaltcode.desktop.development');
      const actual = JSON.parse(execSync(details.relaunchCommand!, { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
      expect(realpathSync(actual.entry)).toBe(realpathSync(appPath));
      expect(actual.args).toEqual(['--development-preview']);
    }
  });

  it('relaunches a packaged preview through the main executable, not an archived application or document path', () => {
    const { root } = fixture();
    const details = desktopWindowDetails({ packaged: true, testing: false, developmentPreview: true, executable: process.execPath, appPath: join(root, 'resources/app.asar'), sourceIcon });
    expect(details.relaunchCommand).toBe('"' + process.execPath + '" --development-preview');
    expect(details.appId).toBe('app.smaltcode.desktop.development');
    expect(realpathSync(details.appIconPath!)).toBe(realpathSync(process.execPath));
  });

  it('isolates all automated checks from source and installed groups without changing visible-window switches', () => {
    expect(desktopTestSwitches).toContain('identity-test');
    expect(new Set([desktopAppId(true, false), desktopAppId(true, false, true), desktopAppId(false, true, true)]).size).toBe(3);
    for (const packaged of [false, true]) for (const preview of [false, true]) expect(desktopAppId(packaged, true, preview)).toBe('app.smaltcode.desktop.test');
  });

  it('rejects virtual or malformed Shell paths instead of silently giving Windows an unreadable icon', () => {
    const { appPath } = fixture();
    const base = { packaged: false, testing: false, developmentPreview: true, executable: process.execPath, appPath, sourceIcon };
    expect(() => desktopWindowDetails({ ...base, sourceIcon: join(appPath, 'app.asar/dist/main/smalt.ico') })).toThrow('real filesystem');
    expect(() => desktopWindowDetails({ ...base, appPath: appPath + '" --bad' })).toThrow('relaunch path');
    expect(() => desktopWindowDetails({ ...base, executable: 'relative.exe' })).toThrow('relaunch path');
  });
});
