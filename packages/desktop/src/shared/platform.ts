/** Platform decisions shared by native chrome and its local renderer. */
export type AppCommand = 'new-task' | 'settings';

export function windowChrome(platform: string) {
  return platform === 'darwin'
    ? { frame: true, titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 13 } }
    : { frame: false };
}

export function shortcutText(text: string, platform: string): string {
  return platform === 'darwin'
    ? text.replace(/\bCtrl\b/g, '⌘').replace(/\bShift\b/g, '⇧').replace(/\bAlt\b/g, '⌥')
    : text;
}
