import { basename, isAbsolute } from 'node:path';
import type { AppDetailsOptions } from 'electron';

/** Keep development and automated checks out of the installed taskbar group. */
export function desktopAppId(packaged: boolean, testing: boolean, developmentPreview = false): string {
  const id = 'app.smaltcode.desktop';
  return testing ? id + '.test' : packaged && !developmentPreview ? id : id + '.development';
}

export const desktopTestSwitches = ['ui-test', 'smoke-test', 'tray-smoke-test', 'identity-test'] as const;

type DesktopWindowIdentity = {
  packaged: boolean;
  testing: boolean;
  developmentPreview: boolean;
  executable: string;
  appPath: string;
  sourceIcon: string;
};

function shellArgument(value: string): string {
  if (!isAbsolute(value) || /["\r\n\0]/.test(value)) throw new Error('Invalid application relaunch path');
  return '"' + value + '"';
}

/** Windows Shell cannot read an icon through Electron's ASAR virtual filesystem. */
export function desktopWindowDetails(options: DesktopWindowIdentity): AppDetailsOptions {
  // A renamed preview runtime can report isPackaged=true while opening the source app.
  const source = !options.packaged || options.developmentPreview && !/([\\/])app\.asar(?:[\\/]|$)/i.test(options.appPath);
  // Keep the branded preview's Shell resource aligned with its registered shortcut.
  const brandedPreview = basename(options.executable).toLowerCase() === 'smaltcode preview.exe';
  const icon = source && !brandedPreview ? options.sourceIcon : options.executable;
  if (!isAbsolute(icon) || /([\\/])app\.asar(?:[\\/]|$)/i.test(icon) || /["\r\n\0]/.test(icon)) {
    throw new Error('Windows taskbar icon must use a real filesystem path');
  }
  const command = shellArgument(options.executable) + (source ? ' ' + shellArgument(options.appPath) : '') + (options.developmentPreview ? ' --development-preview' : '');
  return {
    appId: desktopAppId(options.packaged, options.testing, options.developmentPreview),
    appIconPath: icon,
    appIconIndex: 0,
    relaunchDisplayName: options.developmentPreview ? 'SmaltCode 开发预览' : 'SmaltCode',
    relaunchCommand: command,
  };
}
