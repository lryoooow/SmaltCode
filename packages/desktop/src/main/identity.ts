/** Keep development and automated checks out of the installed taskbar group. */
export function desktopAppId(packaged: boolean, testing: boolean): string {
  const id = 'app.smaltcode.desktop';
  return testing ? id + '.test' : packaged ? id : id + '.development';
}

export const desktopTestSwitches = ['ui-test', 'smoke-test', 'tray-smoke-test'] as const;
