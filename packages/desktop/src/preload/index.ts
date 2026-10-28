/**
 * Preload: the ONLY surface exposed to the renderer. Keep it tiny —
 * contextIsolation stays on, nodeIntegration stays off.
 */

import { contextBridge, ipcRenderer } from 'electron';

const versionArg = process.argv.find((a) => a.startsWith('--smalt-version='));

contextBridge.exposeInMainWorld('smalt', {
  webSearch: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:web-search', action, value),
  fileContext: (action:string,value:unknown={})=>ipcRenderer.invoke('smalt:file-context',action,value),
  artifacts:(action:string,value:unknown={})=>ipcRenderer.invoke('smalt:artifacts',action,value),
  onArtifactSelection:(cb:(v:{threadId:string;text:string})=>void)=>{const h=(_e:unknown,v:{threadId:string;text:string})=>cb(v);ipcRenderer.on('smalt:artifact-selection',h);return()=>ipcRenderer.removeListener('smalt:artifact-selection',h);},
  onArtifactUpdated:(cb:(value:{threadId:string;path:string})=>void)=>{const handler=(_e:unknown,value:{threadId:string;path:string})=>cb(value);ipcRenderer.on('smalt:artifact-updated',handler);return()=>ipcRenderer.removeListener('smalt:artifact-updated',handler);},
  version: versionArg ? versionArg.split('=')[1]! : '0.0.0',
  platform: process.platform,
  developmentPreview: process.argv.includes('--smalt-development-preview'),

  /** invoke a kernel JSON-RPC method */
  call: (method: string, params?: unknown) => ipcRenderer.invoke('smalt:call', method, params),
  localSpace: (action: 'create' | 'info') => ipcRenderer.invoke('smalt:local-space', action),

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
  skills: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:skills', action, value),
  pickAttachments: () => ipcRenderer.invoke('smalt:attachments:pick'),
  pasteImage: (base64: string, mime: string) => ipcRenderer.invoke('smalt:attachments:image', base64, mime),
  attachment: (id: string) => ipcRenderer.invoke('smalt:attachments:preview', id),
  processes: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:processes', action, value),
  browser: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:browser', action, value),
  containers:(action:string,value?:unknown)=>ipcRenderer.invoke('smalt:containers',action,value),
  onContainers:(cb:()=>void)=>{const listener=()=>cb();ipcRenderer.on('smalt:containers',listener);return()=>ipcRenderer.removeListener('smalt:containers',listener);},
  ssh:(action:string,value?:unknown)=>ipcRenderer.invoke('smalt:ssh',action,value),
  onSsh:(cb:()=>void)=>{const listener=()=>cb();ipcRenderer.on('smalt:ssh',listener);return()=>ipcRenderer.removeListener('smalt:ssh',listener);},
  remote: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:remote', action, value),
  onRemote: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on('smalt:remote', listener); return () => ipcRenderer.removeListener('smalt:remote', listener); },
  collaborations: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:collaborations', action, value),
  onCollaborations: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on('smalt:collaborations', listener); return () => ipcRenderer.removeListener('smalt:collaborations', listener); },
  autonomy: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:autonomy', action, value),
  onAutonomy: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on('smalt:autonomy', listener); return () => ipcRenderer.removeListener('smalt:autonomy', listener); },
  integrations: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:integrations', action, value),
  onIntegrations: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on('smalt:integrations', listener); return () => ipcRenderer.removeListener('smalt:integrations', listener); },
  feedback: (action: string, value?: unknown) => ipcRenderer.invoke('smalt:feedback', action, value),
  onBrowser: (cb: () => void) => { const listener = () => cb(); ipcRenderer.on('smalt:browser', listener); return () => ipcRenderer.removeListener('smalt:browser', listener); },
  onBrowserShortcut: (cb: (value: { key: string; control: boolean; shift?: boolean }) => void) => { const listener = (_event: unknown, value: { key: string; control: boolean; shift?: boolean }) => cb(value); ipcRenderer.on('smalt:browser-shortcut', listener); return () => ipcRenderer.removeListener('smalt:browser-shortcut', listener); },
  onProcess: (cb: (event: unknown) => void) => { const listener = (_event: unknown, value: unknown) => cb(value); ipcRenderer.on('smalt:process', listener); return () => ipcRenderer.removeListener('smalt:process', listener); },
  overview: () => ipcRenderer.invoke('smalt:overview'),
  exportDiagnostics: () => ipcRenderer.invoke('smalt:diagnostics:export'),
  searchFiles: (cwd: string, query: string) => ipcRenderer.invoke('smalt:context', cwd, 'search', query),
  previewFile: (cwd: string, path: string,fileScope?:string) => ipcRenderer.invoke('smalt:context', cwd, 'preview', path,undefined,fileScope),
  inspectContext: (cwd: string, refs: unknown[],fileScope?:string) => ipcRenderer.invoke('smalt:context', cwd, 'inspect', refs,undefined,fileScope),
  resolveContext: (cwd: string, refs: unknown[],threadId?:string,fileScope?:string) => ipcRenderer.invoke('smalt:context', cwd, 'resolve', refs,threadId,fileScope),
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
