import { describe, expect, it } from 'vitest';
import { desktopAppId } from '../src/main/identity.js';

describe('Windows taskbar identity', () => {
  it('matches the installed shortcut and keeps development and checks separate', () => {
    expect(desktopAppId(true, false)).toBe('app.smaltcode.desktop');
    expect(desktopAppId(false, false)).toBe('app.smaltcode.desktop.development');
    expect(desktopAppId(false, true)).toBe('app.smaltcode.desktop.test');
    expect(desktopAppId(true, true)).toBe('app.smaltcode.desktop.test');
    expect(new Set([desktopAppId(true, false), desktopAppId(false, false), desktopAppId(true, true)]).size).toBe(3);
  });
});
