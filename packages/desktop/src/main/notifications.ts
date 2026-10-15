import { app, BrowserWindow, Notification, type WebContents } from 'electron';
import { join } from 'node:path';
import { desktopTestSwitches } from './identity.js';

/** OS alerts complement the task center; they never steal focus or auto-approve. */
export class DesktopNotifications {
  private current: string | null = null;
  private enabled = true;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private alerts = new Map<string, Notification>();
  private threads = new Map<string, string>();
  constructor(private readonly contents: WebContents) {}
  configure(threadId: string | null, enabled: boolean) { this.current = threadId; this.enabled = enabled; if (!enabled) this.dispose(); }
  resolve(key: string) { clearTimeout(this.pending.get(key)); this.pending.delete(key); this.alerts.get(key)?.close(); this.alerts.delete(key); this.threads.delete(key); }
  resolveThread(threadId: string) { for (const [key, id] of this.threads) if (id === threadId) this.resolve(key); }
  show(threadId: string, key: string, title: string, body: string) {
    if (!this.enabled || this.pending.has(key) || this.alerts.has(key)) return;
    const testing = desktopTestSwitches.some(flag => app.commandLine.hasSwitch(flag));
    // Even isSupported() can initialise Windows notification registration and
    // create a Start Menu shortcut. Simulated alerts must bypass native APIs.
    if (!testing && (typeof Notification?.isSupported !== 'function' || !Notification.isSupported())) return;
    this.threads.set(key, threadId);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      const win = BrowserWindow.fromWebContents(this.contents);
      if (!this.enabled || this.contents.isDestroyed() || (this.current === threadId && win?.isFocused() && win.isVisible())) { this.threads.delete(key); return; }
      if (testing) { console.log('[notification-test]', JSON.stringify({ threadId, title })); this.threads.delete(key); return; }
      try {
      if (this.alerts.size >= 64) this.resolve(this.alerts.keys().next().value!);
      const alert = new Notification({ title: 'SmaltCode · ' + title, body: body.slice(0, 120), silent: true, icon: join(__dirname, 'smalt.png') });
      this.alerts.set(key, alert);
      alert.on('click', () => { if (this.contents.isDestroyed()) return; if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); this.contents.send('smalt:navigate', { threadId }); });
      alert.on('close', () => { this.alerts.delete(key); this.threads.delete(key); });
      alert.show();
      } catch (error) { this.alerts.delete(key); this.threads.delete(key); console.warn('[notifications] system notification unavailable:', error instanceof Error ? error.message : String(error)); }
    }, 1000);
    timer.unref?.(); this.pending.set(key, timer);
  }
  dispose() { for (const key of new Set([...this.pending.keys(), ...this.alerts.keys(), ...this.threads.keys()])) this.resolve(key); }
}
