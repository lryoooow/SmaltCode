export type BrowserTab = { id: string; threadId: string; title: string; url: string; localPath?: string; externalSource?: string; loading: boolean; back: boolean; forward: boolean; zoom: number; sources: string[]; notice?: string; pendingURL?: string; error?: string }
export type BrowserState = { tabs: BrowserTab[] }
export type ObjectSelection = { kind: 'image'; x: number; y: number; width: number; height: number } | { kind: 'cells'; sheet: number; row: number; column: number; endRow: number; endColumn: number }
