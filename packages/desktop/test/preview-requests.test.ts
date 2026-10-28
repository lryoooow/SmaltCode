import { describe, expect, it } from 'vitest';
import { applyBrowserPreviewRequest, applyPreviewRequest, emptyPreview, openPreview, type PreviewSectionRequest } from '../src/renderer/src/c/preview-state';

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
  it('activates a newly opened citation when an older browser tab and file tabs already exist', () => {
    const previous = { ...openPreview(emptyPreview(), file), browserActive: 'web_existing' };
    const next = applyBrowserPreviewRequest(previous, { sequence: 1, target: 'web_citation' });
    expect(next.browserActive).toBe('web_citation'); expect(next.section).toBe('browser'); expect(next.active).toBeNull();
    expect(next.tabs).toBe(previous.tabs); expect(previous.browserActive).toBe('web_existing'); expect(previous.active).toBe('notes.md');
  });
  it('keeps the current tab while opening the browser section and chooses the source only once it returns', () => {
    const current = { ...emptyPreview(), browserActive: 'web_existing' };
    const waiting = applyBrowserPreviewRequest(current, { sequence: 1 });
    expect(waiting.browserActive).toBe('web_existing'); expect(waiting.section).toBe('browser');
    const opened = applyBrowserPreviewRequest(waiting, { sequence: 2, target: 'web_citation' });
    expect(opened.browserActive).toBe('web_citation'); expect(opened.requests?.browser).toBe(2);
  });
  it('does not replay a consumed citation after a user selects a different browser or file tab', () => {
    const request = { sequence: 2, target: 'web_citation' };
    const opened = applyBrowserPreviewRequest(emptyPreview(), request);
    const manuallySelected = { ...opened, browserActive: 'web_existing' };
    const memory = new Map([['first', manuallySelected], ['second', emptyPreview()]]);
    expect(applyBrowserPreviewRequest(memory.get('first')!, request)).toBe(manuallySelected);
    expect(memory.get('first')!.browserActive).toBe('web_existing');
    const selectedFile = openPreview(manuallySelected, file);
    expect(applyBrowserPreviewRequest(selectedFile, request)).toBe(selectedFile);
    const browserAgain = applyBrowserPreviewRequest(selectedFile, { sequence: 3 });
    expect(browserAgain.section).toBe('browser'); expect(browserAgain.browserActive).toBe('web_existing');
  });
  it('applies a late citation only to its owning chat memory without changing another chat selection', () => {
    const a = { ...emptyPreview(), browserActive: 'web_a' }, b = openPreview(emptyPreview(), file);
    const memory = new Map([['first', a], ['second', b]]);
    memory.set('first', applyBrowserPreviewRequest(memory.get('first')!, { sequence: 4, target: 'web_citation_a' }));
    expect(memory.get('first')!.browserActive).toBe('web_citation_a'); expect(memory.get('second')).toBe(b); expect(b.active).toBe('notes.md');
    const selected = { ...memory.get('first')!, browserActive: 'web_user_choice' };
    for (const sequence of [0, -1, 3, 4, NaN, Infinity, 4.5]) expect(applyBrowserPreviewRequest(selected, { sequence, target: 'web_stale' })).toBe(selected);
  });
});
