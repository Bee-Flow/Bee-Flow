import { describe, it, expect, vi, afterEach } from 'vitest';
import { openPreviewInNewTab, PREVIEW_SANDBOX } from './openPreviewTab';

/**
 * "Open in a new tab" shows the page in a sandboxed frame, never as the tab's
 * own document. These tests stand in a real, empty document for the new tab
 * and check what ends up in it.
 */

function fakeTab() {
    const doc = document.implementation.createHTMLDocument('');
    return { document: doc, opener: window as Window | null } as unknown as Window & { opener: Window | null };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('openPreviewInNewTab', () => {
    it('opens an empty tab and frames the composed document under the preview sandbox', () => {
        const tab = fakeTab();
        const open = vi.spyOn(window, 'open').mockReturnValue(tab);
        const createUrl = vi.spyOn(URL, 'createObjectURL');

        const srcDoc = '<!doctype html><p>made by the page</p><script>window.x = 1</script>';
        expect(openPreviewInNewTab({ isFull: false, fullTierUrl: null, srcDoc }, 'Webpage preview')).toBe(true);

        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][0]).toBe('');
        expect(createUrl).not.toHaveBeenCalled();

        const frames = tab.document.querySelectorAll('iframe');
        expect(frames).toHaveLength(1);
        expect(frames[0].getAttribute('sandbox')).toBe(PREVIEW_SANDBOX);
        expect(PREVIEW_SANDBOX).not.toContain('allow-same-origin');
        expect(frames[0].getAttribute('srcdoc')).toBe(srcDoc);
        expect(tab.document.title).toBe('Webpage preview');
        // The page's markup is the frame's, not the tab's.
        expect(tab.document.body.querySelector('p, script')).toBeNull();
    });

    it('cuts the tab loose from the editor window', () => {
        const tab = fakeTab();
        vi.spyOn(window, 'open').mockReturnValue(tab);
        openPreviewInNewTab({ isFull: false, fullTierUrl: null, srcDoc: '<p>x</p>' }, 'Preview');
        expect(tab.opener).toBeNull();
    });

    it('frames the full-tier URL under the same sandbox instead of opening it as a page', () => {
        const tab = fakeTab();
        const open = vi.spyOn(window, 'open').mockReturnValue(tab);
        const url = 'https://host.example/api/webpages-preview/wp1/full/?token=t';
        openPreviewInNewTab({ isFull: true, fullTierUrl: url, srcDoc: '' }, 'Preview');

        expect(open.mock.calls[0][0]).toBe('');
        const frame = tab.document.querySelector('iframe');
        expect(frame?.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX);
        expect(frame?.getAttribute('src')).toBe(url);
    });

    it('opens nothing for the full tier before its URL exists', () => {
        const open = vi.spyOn(window, 'open');
        expect(openPreviewInNewTab({ isFull: true, fullTierUrl: null, srcDoc: '' }, 'Preview')).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('never hands window.open a blob: or data: URL', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(fakeTab());
        openPreviewInNewTab({ isFull: false, fullTierUrl: null, srcDoc: '<p>x</p>' }, 'Preview');
        for (const [target] of open.mock.calls) {
            expect(String(target ?? '')).not.toMatch(/^(blob|data):/i);
        }
    });

    it('reports a refused tab', () => {
        vi.spyOn(window, 'open').mockReturnValue(null);
        expect(openPreviewInNewTab({ isFull: false, fullTierUrl: null, srcDoc: '<p>x</p>' }, 'Preview')).toBe(false);
    });
});
