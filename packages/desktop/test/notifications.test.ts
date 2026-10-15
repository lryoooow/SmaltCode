import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ alerts: [] as any[], focused: false, visible: true, minimized: false, show: vi.fn(), restore: vi.fn(), focus: vi.fn(), send: vi.fn(), destroyed: false }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Alert extends EventEmitter {
    static isSupported() { return true; }
    show = vi.fn(); close = vi.fn();
    constructor(readonly options: any) { super(); state.alerts.push(this); }
  }
  return { app: { commandLine: { hasSwitch: () => false } }, Notification: Alert, BrowserWindow: { fromWebContents: () => ({ isFocused: () => state.focused, isVisible: () => state.visible, isMinimized: () => state.minimized, restore: state.restore, show: state.show, focus: state.focus }) } };
});
import { DesktopNotifications } from '../src/main/notifications.js';
let service: DesktopNotifications;
beforeEach(() => { vi.useFakeTimers(); state.alerts.length = 0; state.focused = false; state.visible = true; state.minimized = false; state.destroyed = false; service = new DesktopNotifications({ isDestroyed: () => state.destroyed, send: state.send } as any); });
afterEach(() => { service.dispose(); vi.useRealTimers(); vi.clearAllMocks(); });
describe('desktop task notifications', () => {
  it('deduplicates alerts and restores the precise conversation on click', () => {
    state.minimized = true;
    service.show('a', 'approval-id', '需要审批', 'task a'); service.show('a', 'approval-id', '需要审批', 'task a'); vi.advanceTimersByTime(1000);
    expect(state.alerts).toHaveLength(1); expect(state.alerts[0].options).toMatchObject({ title: 'SmaltCode · 需要审批', silent: true });
    expect(state.focus).not.toHaveBeenCalled(); state.alerts[0].emit('click');
    expect(state.restore).toHaveBeenCalledOnce(); expect(state.focus).toHaveBeenCalledOnce(); expect(state.send).toHaveBeenCalledWith('smalt:navigate', { threadId: 'a' });
  });
  it('does not interrupt a focused conversation and cancels already-resolved requests', () => {
    service.configure('a', true); state.focused = true;
    service.show('a', 'done', '已完成', 'a'); service.show('b', 'question', '等待回答', 'b'); service.resolve('question'); vi.advanceTimersByTime(1000);
    expect(state.alerts).toHaveLength(0);
    service.show('b', 'new-question', '等待回答', 'b'); vi.advanceTimersByTime(1000); expect(state.alerts).toHaveLength(1);
  });
  it('respects notification preferences, window destruction and disposal', () => {
    service.configure(null, false); service.show('a', 'one', '', ''); vi.advanceTimersByTime(1000); expect(state.alerts).toHaveLength(0);
    service.configure(null, true); service.show('a', 'two', '', ''); state.destroyed = true; vi.advanceTimersByTime(1000); expect(state.alerts).toHaveLength(0);
    state.destroyed = false; service.show('a', 'three', '', ''); service.dispose(); vi.advanceTimersByTime(1000); expect(state.alerts).toHaveLength(0);
  });
});

it('cancels an archived conversation and closes visible alerts when disabled', () => {
  service.show('a', 'a-done', '', ''); service.show('b', 'b-done', '', ''); service.resolveThread('a'); vi.advanceTimersByTime(1000);
  expect(state.alerts).toHaveLength(1); service.configure(null, false); expect(state.alerts[0].close).toHaveBeenCalledOnce();
});
