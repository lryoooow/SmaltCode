/**
 * Preload: the ONLY surface exposed to the renderer. Keep it tiny —
 * contextIsolation stays on, nodeIntegration stays off.
 */

import { contextBridge, ipcRenderer } from 'electron';

const versionArg = process.argv.find((a) => a.startsWith('--smalt-version='));

contextBridge.exposeInMainWorld('smalt', {
  version: versionArg ? versionArg.split('=')[1]! : '0.0.0',
  platform: process.platform,
  developmentPreview: process.argv.includes('--smalt-development-preview'),

  /** invoke a kernel JSON-RPC method */
  call: (method: string, params?: unknown) => ipcRenderer.invoke('smalt:call', method, params),

  /** subscribe to kernel notifications; returns an unsubscribe fn */
  onNotify: (cb: (method: string, params: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { method: string; params: unknown }) =>
      cb(payload.method, payload.params);
    ipcRenderer.on('smalt:notify', listener);
    return () => ipcRenderer.removeListener('smalt:notify', listener);
  },

  /** approval cards call this when the user decides */
  respondApproval: (id: string, decision: { decision: 'allow' | 'deny'; remember?: 'session' | 'always'; reason?: string }) =>
    ipcRenderer.invoke('smalt:approval:respond', id, decision),

  /** ask_user cards call this with the typed answer */
  respondInput: (id: string, text: string) => ipcRenderer.invoke('smalt:input:respond', id, text),

  /** open the native folder picker (workspace rules enforced in main) */
  pickFolder: (defaultPath?: string) => ipcRenderer.invoke('smalt:pick-folder', defaultPath) as Promise<
    { canceled: true; reason?: string } | { canceled: false; dir: string }
  >,

  loadSettings: () => ipcRenderer.invoke('smalt:settings:load') as Promise<{
    providers: Record<string, { baseUrl: string; wire: string; apiKeyEnv?: string; hasKey: boolean; defaultModel?: string }>;
    effective: { defaultProvider: string; defaultModel: string; permissionMode: string };
  }>,

  saveSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('smalt:settings:save', patch) as Promise<{ ok: boolean }>,
  testProvider: (provider: string, model: string) => ipcRenderer.invoke('smalt:settings:test', provider, model),
  listModels: (provider: string, force = false, model?: string) => ipcRenderer.invoke('smalt:models:list', provider, force, model),
  pickFiles: () => ipcRenderer.invoke('smalt:pick-files'),
  skills: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:skills', action, value),
  pickAttachments: () => ipcRenderer.invoke('smalt:attachments:pick'),
  pasteImage: (base64: string, mime: string) => ipcRenderer.invoke('smalt:attachments:image', base64, mime),
  attachment: (id: string) => ipcRenderer.invoke('smalt:attachments:preview', id),
  overview: () => ipcRenderer.invoke('smalt:overview'),
  exportDiagnostics: () => ipcRenderer.invoke('smalt:diagnostics:export'),
  searchFiles: (cwd: string, query: string) => ipcRenderer.invoke('smalt:context', cwd, 'search', query),
  previewFile: (cwd: string, path: string) => ipcRenderer.invoke('smalt:context', cwd, 'preview', path),
  resolveContext: (cwd: string, refs: unknown[]) => ipcRenderer.invoke('smalt:context', cwd, 'resolve', refs),
  activity: (threadId: string | null, enabled: boolean) => ipcRenderer.invoke('smalt:activity', threadId, enabled),
  onNavigate: (cb: (threadId: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { threadId: string }) => cb(payload.threadId);
    ipcRenderer.on('smalt:navigate', listener);
    return () => ipcRenderer.removeListener('smalt:navigate', listener);
  },
  file: (threadId: string, path: string, action: 'read' | 'reveal') => ipcRenderer.invoke('smalt:file', threadId, path, action),
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('smalt:window', action),
  onResolved: (cb: (id: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { id: string }) => cb(payload.id);
    ipcRenderer.on('smalt:resolved', listener);
    return () => ipcRenderer.removeListener('smalt:resolved', listener);
  },
  onApproval: (cb: (req: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { req: unknown }) => cb(payload.req);
    ipcRenderer.on('smalt:approval', listener);
    return () => ipcRenderer.removeListener('smalt:approval', listener);
  },
  onInput: (cb: (req: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { req: unknown }) => cb(payload.req);
    ipcRenderer.on('smalt:input', listener);
    return () => ipcRenderer.removeListener('smalt:input', listener);
  },
});
