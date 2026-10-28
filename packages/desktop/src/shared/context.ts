export type ContextReference = { path: string; start?: number; end?: number; digest?: string; label?: string }
export type ContextInspection = {
  path: string; label: string; source: string; kind: 'source' | 'workspace' | 'attachment' | 'skill' | 'feedback' | 'memory' | 'ssh';
  valid: boolean; error?: string; digest?: string; format?: string; selected: boolean;
  startLine?: number; endLine?: number; characters?: number; totalCharacters?: number;
  truncated?: boolean; excerpt?: string; warnings: string[];
}
export type ContextCheck = { entries: ContextInspection[]; checkedAt: string; error?: string }
