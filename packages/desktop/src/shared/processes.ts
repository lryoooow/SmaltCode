export type ProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'stopped' | 'interrupted'
export type ProcessLaunch = { program?: string; args?: string[]; command?: string; cwd?: string; title?: string }
export type ManagedProcess = {
  id: string; revision: number; threadId: string; workspace: string; cwd: string; title: string;
  command: string; kind: 'background' | 'terminal'; source: 'model' | 'user' | 'project';
  state: ProcessState; pid?: number; startedAt: string; endedAt?: string; exitCode?: number;
  error?: string; inputAllowed: boolean; columns: number; rows: number; truncated: boolean;
  actionId?: string;
}
export type ProcessOutput = { data: string; from: number; end: number }
export type ProcessEvent = { process: ManagedProcess; output?: ProcessOutput }
export type ProjectOperation = { id: string; title: string; cwd: string; launch: ProcessLaunch; digest: string; script?: string; origin: 'package' | 'custom' | 'builtin' }
