export type UsageRow = { id: string; title: string; model: string; archived: boolean; inputTokens: number; outputTokens: number; recorded: boolean; updatedAt: string; recovery?: { turnId: string; startedAt: string }; running: boolean };
export type DesktopOverview = {
  usage: { inputTokens: number; outputTokens: number; conversations: number; unreported: number; rows: UsageRow[] };
  diagnostics: { version: string; platform: string; packaged: boolean; electron: string; node: string; keyStorage: 'encrypted' | 'session'; runtimeFiles: Array<{ name: string; present: boolean }>; parserReady: boolean; skills: number };
};
