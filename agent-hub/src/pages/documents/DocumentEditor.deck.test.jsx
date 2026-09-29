import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The editor for a PRESENTATION: the outline pane beside the slides, the
 * live draft preview (rendered by the server, shown by the canvas, never
 * saved), the same autosave a page has, and the .pptx download.
 *
 * DocumentCanvas is stubbed to expose what the editor hands it (setDraft) —
 * the real one needs an iframe.
 */

const { api, canvas } = vi.hoisted(() => ({
    api: {
        getDocument: vi.fn(),
        updateDocument: vi.fn(),
        downloadPdf: vi.fn(),
        downloadPptx: vi.fn(),
        previewDeckDraft: vi.fn(),
        listVersions: vi.fn(),
        restoreVersion: vi.fn(),
        createDocument: vi.fn(),
        previewUrl: vi.fn(() => '/preview'),
    },
    canvas: { drafts: [] },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (k, fb) => fb || k, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('./DocumentCanvas', async () => {
    const React = await import('react');
    const Fake = React.forwardRef(({ editing, onDeckReady }, ref) => {
        React.useImperativeHandle(ref, () => ({
            flush: async () => {},
            invalidate: () => {},
            insert: () => {},
            section: () => {},
            setDraft: (html) => { canvas.drafts.push(html); },
            goto: () => {},
        }));
        React.useEffect(() => { onDeckReady?.(4); }, [onDeckReady]);
        return <div data-testid="fake-canvas" data-editing={String(editing)}>canvas</div>;
    });
    return { default: Fake };
});
vi.mock('./DocumentWorkspacePanel', async () => {
    const React = await import('react');
    const Fake = React.forwardRef(({ tab, onPreviewDraft }, ref) => {
        React.useImperativeHandle(ref, () => ({ flush: async () => {} }));
        return <button data-testid="fake-panel" data-tab={tab} onClick={() => onPreviewDraft?.({ settings: { deck: { preset: 'dark' } } })}>panel</button>;
    });
    return { default: Fake };
});

const DocumentEditor = (await import('./DocumentEditor')).default;

const OUTLINE = '# Kick-off\n\n## Goals\n- a\n';
const DECK = { id: 'p1', name: 'Kick-off', docType: 'presentation', bodyHtml: OUTLINE, css: '', settings: { deck: {} }, versionId: 'v1' };

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    canvas.drafts.length = 0;
    api.getDocument.mockReset().mockResolvedValue(DECK);
    api.updateDocument.mockReset().mockImplementation(async (_id, patch) => ({ ...DECK, ...patch, versionId: 'v2' }));
    api.downloadPdf.mockReset().mockResolvedValue({ degraded: false });
    api.downloadPptx.mockReset().mockResolvedValue({ degraded: false });
    api.previewDeckDraft.mockReset().mockResolvedValue('<html>draft</html>');
    api.listVersions.mockReset().mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function renderEditor(props = {}) {
    const out = render(<DocumentEditor documentId="p1" onBack={() => {}} {...props} />);
    await screen.findByTestId('fake-canvas');
    return out;
}

describe('DocumentEditor — a presentation', () => {
    it('offers "Edit outline" instead of "Edit text", a PowerPoint download, the Look tab, and the slide count', async () => {
        await renderEditor();
        expect(screen.getByText('Edit outline')).toBeTruthy();
        expect(screen.getByTestId('document-download-pptx')).toBeTruthy();
        expect(screen.getByTestId('document-download-pdf').textContent).toBe('PDF');
        expect(screen.getByRole('button', { name: 'Look' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Sections' })).toBeNull();
        expect((await screen.findByTestId('document-slide-count')).textContent).toBe('4 slides');
    });

    it('the outline pane opens beside the slides, typing redraws them as a DRAFT and autosaves the outline', async () => {
        await renderEditor();
        expect(screen.queryByTestId('deck-outline')).toBeNull();
        fireEvent.click(screen.getByText('Edit outline'));
        const outline = screen.getByTestId('deck-outline');
        expect(outline.value).toBe(OUTLINE);
        // The canvas never edits a presentation in place.
        expect(screen.getByTestId('fake-canvas').getAttribute('data-editing')).toBe('false');

        fireEvent.change(outline, { target: { value: OUTLINE + '\n## More\n- b\n' } });
        expect(api.previewDeckDraft).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(500); });
        await waitFor(() => expect(api.previewDeckDraft).toHaveBeenCalledTimes(1));
        expect(api.previewDeckDraft.mock.calls[0][1]).toEqual({ bodyHtml: OUTLINE + '\n## More\n- b\n' });
        await waitFor(() => expect(canvas.drafts).toEqual(['<html>draft</html>']));
        expect(api.updateDocument).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(1600); });
        expect(api.updateDocument).toHaveBeenCalledWith('p1', { bodyHtml: OUTLINE + '\n## More\n- b\n', expectedVersionId: 'v1' });
    });

    it('a look change from the panel previews as a draft that also carries the outline being typed', async () => {
        await renderEditor();
        fireEvent.click(screen.getByText('Edit outline'));
        fireEvent.change(screen.getByTestId('deck-outline'), { target: { value: '# Draft\n\n## X\n- 1' } });
        fireEvent.click(screen.getByRole('button', { name: 'Look' }));
        fireEvent.click(await screen.findByTestId('fake-panel'));
        await act(async () => { vi.advanceTimersByTime(500); });
        await waitFor(() => expect(api.previewDeckDraft).toHaveBeenCalled());
        const last = api.previewDeckDraft.mock.calls.at(-1)[1];
        expect(last).toEqual({ bodyHtml: '# Draft\n\n## X\n- 1', settings: { deck: { preset: 'dark' } } });
    });

    it('a preview that fails is said, quietly, without touching the save', async () => {
        api.previewDeckDraft.mockRejectedValue(new Error('The outline is too large'));
        await renderEditor();
        fireEvent.click(screen.getByText('Edit outline'));
        fireEvent.change(screen.getByTestId('deck-outline'), { target: { value: '# x\n\n## y\n- z' } });
        await act(async () => { vi.advanceTimersByTime(500); });
        await waitFor(() => expect(screen.getByTestId('document-preview-error').textContent).toMatch(/too large/));
        await act(async () => { vi.advanceTimersByTime(1600); });
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
    });

    it('downloads the .pptx after flushing what was typed; the PDF button stays', async () => {
        await renderEditor();
        fireEvent.click(screen.getByText('Edit outline'));
        fireEvent.change(screen.getByTestId('deck-outline'), { target: { value: '# typed\n\n## a\n- b' } });
        fireEvent.click(screen.getByTestId('document-download-pptx'));
        await waitFor(() => expect(api.downloadPptx).toHaveBeenCalledTimes(1));
        expect(api.updateDocument).toHaveBeenCalledWith('p1', expect.objectContaining({ bodyHtml: '# typed\n\n## a\n- b' }));
        expect(api.updateDocument.mock.invocationCallOrder[0]).toBeLessThan(api.downloadPptx.mock.invocationCallOrder[0]);
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(() => expect(api.downloadPdf).toHaveBeenCalledTimes(1));
    });

    it('a blank presentation opens straight into the outline pane', async () => {
        api.getDocument.mockResolvedValue({ ...DECK, bodyHtml: '' });
        await renderEditor();
        expect(screen.getByTestId('deck-outline')).toBeTruthy();
    });

    it('a page document is untouched: Edit text, Download PDF, no outline pane', async () => {
        api.getDocument.mockResolvedValue({ id: 'p1', name: 'Letter', docType: 'letter', bodyHtml: '<p>a</p>', css: '', versionId: 'v1' });
        await renderEditor();
        expect(screen.getByText('Edit text')).toBeTruthy();
        expect(screen.queryByTestId('document-download-pptx')).toBeNull();
        expect(screen.getByTestId('document-download-pdf').textContent).toBe('Download PDF');
        fireEvent.click(screen.getByText('Edit text'));
        expect(screen.queryByTestId('deck-outline')).toBeNull();
        expect(screen.getByTestId('fake-canvas').getAttribute('data-editing')).toBe('true');
    });
});
