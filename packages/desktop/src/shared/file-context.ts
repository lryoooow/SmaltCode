export type FileRoot = { id: string; label: string; path: string; canonical: string; kind: 'source' | 'workspace'; file: boolean };
export type FileContextView = {
  scope: string; revision: number; sources: FileRoot[]; workspaces: FileRoot[];
  primary?: string; projectDefault?:string; cwd: string; output: string; legacy: boolean; bound: boolean; notice?: string;
};
export type ProjectFileContext = { sources: string[]; workspaces: string[]; primary?: string };
export type TaskFile = { name: string; path: string; relative: string; size: number; modifiedAt: string; versions: number };
export type FileVersion = { digest: string; at: string; size: number };
