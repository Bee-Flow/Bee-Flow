import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The editor's job is to not lose what someone typed. Everything here is about
 * that one property, because it is the failure the user notices last and
 * forgives least: the sentence was on screen, and then it was not in the PDF.
 *
 * DocumentCanvas is stubbed to a button that fires one onDirty — the real one
 * needs an iframe and a postMessage round-trip, and none of the save logic
 * lives there.
 */

const { api } = vi.hoisted(() => ({
    api: {
        getDocument: vi.fn(),
        updateDocument: vi.fn(),
        downloadPdf: vi.fn(),
        listVersions: vi.fn(),
        restoreVersion: vi.fn(),
        previewUrl: vi.fn(() => '/preview'),
    },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (k, fb) => fb || k, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('./DocumentCanvas', () => ({
    default: ({ onDirty, editing }) => (
        <button
            data-testid="fake-canvas"
            data-editing={String(editing)}
            onClick={() => onDirty('<p>edited</p>')}
        >
            canvas
        </button>
    ),
}));

const DocumentEditor = (await import('./DocumentEditor')).default;

const DOC = { id: 'd1', name: 'Factuur 2026-014', docType: 'invoice', bodyHtml: '<p>a</p>', css: '' };

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getDocument.mockReset().mockResolvedValue(DOC);
    api.updateDocument.mockReset().mockResolvedValue(DOC);
    api.downloadPdf.mockReset().mockResolvedValue({ degraded: false });
    api.listVersions.mockReset().mockResolvedValue([]);
    api.restoreVersion.mockReset().mockResolvedValue(DOC);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function renderEditor(props = {}) {
    const out = render(<DocumentEditor documentId="d1" onBack={() => {}} {...props} />);
    await screen.findByTestId('fake-canvas');
    return out;
}

describe('DocumentEditor — autosave', () => {
    it('does not PATCH on every keystroke', async () => {
        // The server snapshots a version on every content PATCH, so a
        // per-keystroke save would mint a history entry per character.
        await renderEditor();
        fireEvent.click(screen.getByTestId('fake-canvas'));
        fireEvent.click(screen.getByTestId('fake-canvas'));
        expect(api.updateDocument).not.toHaveBeenCalled();

        await act(async () => { vi.advanceTimersByTime(1600); });
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
        expect(api.updateDocument).toHaveBeenCalledWith('d1', { bodyHtml: '<p>edited</p>' });
    });

    it('shows Saving… then Saved', async () => {
        await renderEditor();
        fireEvent.click(screen.getByTestId('fake-canvas'));
        expect(screen.getByTestId('document-save-state').getAttribute('data-state')).toBe('saving');
        await act(async () => { vi.advanceTimersByTime(1600); });
        await waitFor(() => {
            expect(screen.getByTestId('document-save-state').getAttribute('data-state')).toBe('saved');
        });
    });

    it('keeps the edit pending when the save fails, so the next tick retries it', async () => {
        // A failed save must not be a lost paragraph.
        await renderEditor();
        api.updateDocument.mockRejectedValueOnce(new Error('offline'));
        fireEvent.click(screen.getByTestId('fake-canvas'));
        await act(async () => { vi.advanceTimersByTime(1600); });
        await waitFor(() => {
            expect(screen.getByTestId('document-save-state').getAttribute('data-state')).toBe('error');
        });

        // The body is still in hand: a later flush sends the same content.
        api.updateDocument.mockResolvedValue(DOC);
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        await waitFor(() => {
            expect(api.updateDocument).toHaveBeenLastCalledWith('d1', { bodyHtml: '<p>edited</p>' });
        });
    });
});

describe('DocumentEditor — the PDF', () => {
    it('persists the pending edit BEFORE rendering', async () => {
        // Downloading a PDF that is missing the sentence you just typed is the
        // bug people never report and always notice.
        await renderEditor();
        fireEvent.click(screen.getByTestId('fake-canvas'));
        fireEvent.click(screen.getByTestId('document-download-pdf'));

        await waitFor(() => expect(api.downloadPdf).toHaveBeenCalled());
        const saveOrder = api.updateDocument.mock.invocationCallOrder[0];
        const pdfOrder = api.downloadPdf.mock.invocationCallOrder[0];
        expect(saveOrder).toBeLessThan(pdfOrder);
    });

    it('explains the plainer layout when the server fell back to pdfkit', async () => {
        await renderEditor();
        api.downloadPdf.mockResolvedValue({ degraded: true });
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        expect(await screen.findByText(/without the rendering container/i)).toBeTruthy();
    });

    it('surfaces a render failure instead of failing silently', async () => {
        await renderEditor();
        api.downloadPdf.mockRejectedValue(new Error('This document is still empty.'));
        fireEvent.click(screen.getByTestId('document-download-pdf'));
        expect(await screen.findByText('This document is still empty.')).toBeTruthy();
    });
});

describe('DocumentEditor — edit mode', () => {
    it('is off until asked for, and toggles without remounting the canvas', async () => {
        await renderEditor();
        const canvas = screen.getByTestId('fake-canvas');
        expect(canvas.getAttribute('data-editing')).toBe('false');

        fireEvent.click(screen.getByTestId('document-edit-toggle'));
        // Same element — a remount would reload the frame and throw away
        // whatever had not been saved yet.
        expect(screen.getByTestId('fake-canvas')).toBe(canvas);
        expect(screen.getByTestId('fake-canvas').getAttribute('data-editing')).toBe('true');
    });
});

describe('DocumentEditor — the chat rewriting the open document', () => {
    it('saves the hand-edit before reloading the model\'s version', async () => {
        // Both edits survive, and the history has them as separate entries.
        await renderEditor();
        fireEvent.click(screen.getByTestId('fake-canvas'));
        api.getDocument.mockClear();

        await act(async () => {
            window.dispatchEvent(new CustomEvent('beeflow:document-updated', {
                detail: { documentId: 'd1' },
            }));
        });

        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', { bodyHtml: '<p>edited</p>' }));
        await waitFor(() => expect(api.getDocument).toHaveBeenCalled());
    });

    it('ignores an update aimed at a different document', async () => {
        await renderEditor();
        api.getDocument.mockClear();
        await act(async () => {
            window.dispatchEvent(new CustomEvent('beeflow:document-updated', {
                detail: { documentId: 'other' },
            }));
        });
        expect(api.getDocument).not.toHaveBeenCalled();
    });
});

describe('DocumentEditor — rename', () => {
    it('saves a changed name on blur and leaves an unchanged one alone', async () => {
        const onRenamed = vi.fn();
        await renderEditor({ onRenamed });
        const input = screen.getByLabelText('Document name');

        fireEvent.blur(input, { target: { value: 'Factuur 2026-014' } });
        expect(api.updateDocument).not.toHaveBeenCalled();

        fireEvent.blur(input, { target: { value: '  Factuur 2026-015  ' } });
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', { name: 'Factuur 2026-015' }));
        await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    });
});

describe('DocumentEditor — the per-document house-style opt-out', () => {
    it('reads an ABSENT setting as on, so an old document picks up a new letterhead', async () => {
        // The default is "nobody decided", which must mean yes. A document
        // written before the org had a house style would otherwise be frozen
        // unbranded forever.
        await renderEditor();
        expect(screen.getByTestId('document-house-style-toggle').getAttribute('data-on')).toBe('true');
    });

    it('reads settings.houseStyle === false as off', async () => {
        api.getDocument.mockResolvedValue({ ...DOC, settings: { houseStyle: false } });
        await renderEditor();
        expect(screen.getByTestId('document-house-style-toggle').getAttribute('data-on')).toBe('false');
    });

    it('turning it off MERGES into settings rather than replacing them', async () => {
        // settings is a wholesale column; a naive write would drop every other
        // key somebody put in it.
        api.getDocument.mockResolvedValue({ ...DOC, settings: { somethingElse: 1 } });
        await renderEditor();
        fireEvent.click(screen.getByTestId('document-house-style-toggle'));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', {
            settings: { somethingElse: 1, houseStyle: false },
        }));
    });

    it('turns back on from off', async () => {
        api.getDocument.mockResolvedValue({ ...DOC, settings: { houseStyle: false } });
        await renderEditor();
        fireEvent.click(screen.getByTestId('document-house-style-toggle'));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', {
            settings: { houseStyle: true },
        }));
    });

    it('surfaces a failed toggle instead of silently not changing', async () => {
        await renderEditor();
        api.updateDocument.mockRejectedValue(new Error('nope'));
        fireEvent.click(screen.getByTestId('document-house-style-toggle'));
        expect(await screen.findByText('nope')).toBeTruthy();
    });
});
