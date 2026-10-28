import { describe, expect, it } from 'vitest';
import { applyPreviewRequest, emptyPreview, openPreview, type PreviewSectionRequest } from '../src/renderer/src/c/preview-state';

describe('one-shot inspector requests across chat remounts', () => {
  const file = { path: 'notes.md', name: 'notes.md', kind: 'new' as const, add: 0, del: 0 };
  it('keeps a later file selection when the previous browser request is seen again', () => {
    const browser = applyPreviewRequest(emptyPreview(), 'browser', 1);
    const selected = openPreview(browser, file);
    const restored = applyPreviewRequest(selected, 'browser', 1);
    expect(restored).toBe(selected); expect(restored.active).toBe('notes.md'); expect(restored.tabs).toHaveLength(1);
  });
  it('consumes every section independently and lets a new explicit request change it', () => {
    const sections: PreviewSectionRequest[] = ['processes', 'browser', 'issues', 'plan'];
    let state = emptyPreview(); for (const section of sections) state = applyPreviewRequest(state, section, 2);
    state = openPreview(state, file);
    for (const section of sections) state = applyPreviewRequest(state, section, 2);
    expect(state.active).toBe('notes.md');
    const fresh = applyPreviewRequest(state, 'processes', 3);
    expect(fresh.section).toBe('processes'); expect(fresh.active).toBeNull(); expect(state.active).toBe('notes.md');
  });
  it('does not share request history between chats or treat stale/invalid values as navigation', () => {
    const a = applyPreviewRequest(emptyPreview(), 'browser', 4), b = emptyPreview();
    const selected = openPreview(a, file);
    for (const sequence of [0, -1, 3, NaN, Infinity, 4.5]) expect(applyPreviewRequest(selected, 'browser', sequence)).toBe(selected);
    expect(applyPreviewRequest(b, 'browser', 1).section).toBe('browser'); expect(b.requests).toBeUndefined();
  });
});
