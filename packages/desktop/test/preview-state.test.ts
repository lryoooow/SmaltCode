import { describe, it, expect } from 'vitest';
import { closePreview, emptyPreview, openPreview, trimPreviewMemory } from '../src/renderer/src/c/preview-state';
import type { FileItem } from '../src/renderer/src/c/Task';
const file = (name: string): FileItem => ({ path: name, name, kind: 'new', add: 1, del: 0 });
describe('per-conversation file preview state', () => {
  it('evicts old preview bytes while retaining tabs, position and the active document', () => {
    const older = openPreview(emptyPreview(), file('old.pdf')), current = openPreview(emptyPreview(), file('new.pdf'));
    older.previews['old.pdf'] = { text: 'old', size: 100, binary: false, dataUrl: 'x'.repeat(100) }; older.documentPositions = { 'old.pdf': { page: 3 } };
    current.previews['new.pdf'] = { text: 'new', size: 100, binary: false, dataUrl: 'x'.repeat(100) };
    const memory = new Map([['old', older], ['current', current]]);
    trimPreviewMemory(memory, 'current', 'new.pdf', 250);
    expect(memory.get('old')?.previews).toEqual({}); expect(memory.get('old')?.tabs).toHaveLength(1);
    expect(memory.get('old')?.documentPositions?.['old.pdf'].page).toBe(3); expect(memory.get('current')?.previews['new.pdf']).toBeDefined();
  });
  it('keeps distinct tabs, reuses an existing tab and chooses its neighbor on close', () => {
    const a = openPreview(emptyPreview(), file('a')), b = openPreview(a, file('b')), again = openPreview(b, file('a'));
    expect(again.tabs.map(f => f.path)).toEqual(['a', 'b']); expect(again.active).toBe('a');
    expect(closePreview(again, 'a').active).toBe('b'); expect(closePreview(closePreview(again, 'a'), 'b').active).toBeNull();
  });
  it('retains scroll positions in independent conversation memories and frees closed previews', () => {
    const a = openPreview(emptyPreview(), file('a')); a.scroll['a:content'] = 250; a.previews.a = { binary: false, text: 'content', size: 7 };
    const b = openPreview(emptyPreview(), file('b')); const memory = new Map([['first', a], ['second', b]]);
    expect(memory.get('first')?.scroll['a:content']).toBe(250); expect(memory.get('second')?.tabs[0].path).toBe('b');
    expect(closePreview(a, 'a').previews).toEqual({}); expect(closePreview(a, 'a').scroll).toEqual({});
  });
});
