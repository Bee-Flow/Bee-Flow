import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * The designed-document editor as a person meets it: always editable for an
 * editor, read-only for a viewer, saved as typed and said so calmly, the
 * assistant's edit merged with what was being typed (it used to end in an
 * error), two people in the same part resolved by "compare and choose", and
 * "Anna is also editing Pricing" when somebody else is in the same section.
 *
 * The frame is replaced by a fake that reports what the real bridge would;
 * the bridge itself is tested in server/services/documentEditBridge.test.js.
 */

const { api, canvas } = vi.hoisted(() => ({
    api: {
        getDocumentView: vi.fn(), getDocument: vi.fn(), updateDocument: vi.fn(), downloadPdf: vi.fn(), downloadPptx: vi.fn(),
        fetchRendered: vi.fn(), fetchPreviewHtml: vi.fn(), previewDeckDraft: vi.fn(), postPresence: vi.fn(), createDocument: vi.fn(),
        documentRequest: vi.fn(), getHouseStyle: vi.fn(),
    },
    canvas: { flush: vi.fn(), patchSections: vi.fn(), setDraft: vi.fn(), goto: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('./DocumentCanvas', async () => {
    const R = await import('react');
    type P = { editing: boolean; peers?: unknown[]; onDirty: (h: string) => void; onCaret?: (s: string | null) => void; onOutline?: (i: unknown[]) => void };
    const Fake = R.forwardRef<unknown, P>((props, ref) => {
        R.useImperativeHandle(ref, () => ({
            flush: canvas.flush, invalidate() {}, insert() {}, section() {}, setDraft: canvas.setDraft, goto: canvas.goto,
            scrollTo() {}, find() {}, patchSections: canvas.patchSections, setAnchors() {}, reveal() {},
        }));
        return (
            <div data-testid="fake-canvas" data-editing={String(props.editing)} data-peers={JSON.stringify(props.peers || [])}>
                <button type="button" onClick={() => props.onDirty('<p>edited</p>')}>type in the frame</button>
                <button type="button" onClick={() => props.onCaret?.('pricing')}>caret into pricing</button>
                <button type="button" onClick={() => props.onOutline?.([{ index: 0, level: 2, text: 'Pricing', sectionId: 'pricing' }])}>report outline</button>
            </div>
        );
    });
    return { default: Fake };
});
vi.mock('./PageEditor', () => ({ default: ({ initial }: { initial: { name: string } }) => <div data-testid="page-editor-stub">page {initial.name}</div> }));
vi.mock('../../components/versions/VersionHistoryPanel', () => ({ default: () => <div data-testid="history-stub" /> }));
vi.mock('../../components/comments/CommentsPanel', () => ({ default: () => <div data-testid="comments-stub" /> }));

const { default: DocumentEditor } = await import('./DocumentEditor');

const DOC = { id: 'd1', userId: 'me', name: 'Offer', docType: 'report', bodyHtml: '<p>a</p>', css: '', settings: {}, versionId: 'v1', editable: true, projectId: null as string | null };
const ME = { id: 'me', name: 'Me' };

function open(doc: Partial<typeof DOC> & { projectRole?: string } = {}, props: Record<string, unknown> = {}) {
    api.getDocumentView.mockResolvedValue({ document: { ...DOC, ...doc }, people: {} });
    return render(withQueryClient(<DocumentEditor documentId="d1" onBack={vi.fn()} currentUser={ME} {...props} />));
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const fn of Object.values(api)) fn.mockReset();
    for (const fn of Object.values(canvas)) fn.mockReset();
    canvas.flush.mockResolvedValue(undefined);
    canvas.patchSections.mockResolvedValue({ applied: [], missing: [] });
    api.updateDocument.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...DOC, ...patch, versionId: 'v2' }));
    api.getDocument.mockResolvedValue({ ...DOC, versionId: 'v2' });
    api.postPresence.mockResolvedValue({ peers: [], people: {}, ttlMs: 45000 });
    sessionStorage.clear();
});
afterEach(() => { vi.useRealTimers(); });

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

describe('DocumentEditor: opening', () => {
    it('opens a designed document ready to type for an editor', async () => {
        open();
        const frame = await screen.findByTestId('fake-canvas');
        expect(frame).toHaveAttribute('data-editing', 'true');
        expect(screen.getByRole('radio', { name: /Editing/ })).toBeChecked();
    });

    it('opens it read-only for a project viewer, and says why', async () => {
        open({ editable: false, projectId: 'p1', projectRole: 'viewer' });
        expect(await screen.findByTestId('fake-canvas')).toHaveAttribute('data-editing', 'false');
        expect(screen.getByTestId('document-read-only')).toHaveTextContent('Only its owner and the project\'s editors can change it');
        expect(screen.getByRole('radio', { name: /Editing/ })).toBeDisabled();
    });

    it('tells "not found" from "could not load"', async () => {
        api.getDocumentView.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }));
        const { unmount } = render(withQueryClient(<DocumentEditor documentId="d1" onBack={vi.fn()} currentUser={ME} />));
        expect(await screen.findByText('Document not found.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
        unmount();
        api.getDocumentView.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 })).mockResolvedValueOnce({ document: DOC, people: {} });
        render(withQueryClient(<DocumentEditor documentId="d1" onBack={vi.fn()} currentUser={ME} />));
        expect(await screen.findByRole('alert')).toHaveTextContent('The document could not be loaded.');
        await user().click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('fake-canvas')).toBeInTheDocument();
    });

    it('hands a page to the page editor', async () => {
        open({ docType: 'page', name: 'Minutes' });
        expect(await screen.findByTestId('page-editor-stub')).toHaveTextContent('page Minutes');
    });
});

describe('DocumentEditor: saving', () => {
    it('says "Unsaved changes" while typing and saves once, merged, after the pause', async () => {
        open();
        await user().click(await screen.findByRole('button', { name: 'type in the frame' }));
        expect(screen.getByTestId('document-save-state')).toHaveTextContent('Unsaved changes');
        expect(api.updateDocument).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
        expect(api.updateDocument).toHaveBeenCalledWith('d1', { bodyHtml: '<p>edited</p>', expectedVersionId: 'v1', merge: true });
        await waitFor(() => expect(screen.getByTestId('document-save-state')).toHaveTextContent(/Saved/));
    });

    it('an assistant edit while typing: the typing is saved merged with it, then the result is shown', async () => {
        open();
        await user().click(await screen.findByRole('button', { name: 'type in the frame' }));
        await act(async () => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId: 'd1' } })); });
        await waitFor(() => expect(api.getDocument).toHaveBeenCalled());
        expect(api.updateDocument).toHaveBeenCalledWith('d1', expect.objectContaining({ bodyHtml: '<p>edited</p>', merge: true }));
        expect(api.updateDocument.mock.invocationCallOrder[0]).toBeLessThan(api.getDocument.mock.invocationCallOrder[0]);
        expect(screen.queryByTestId('document-error')).not.toBeInTheDocument();
    });

    it('an update meant for another document is ignored', async () => {
        open();
        await screen.findByTestId('fake-canvas');
        await act(async () => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId: 'other' } })); });
        expect(api.getDocument).not.toHaveBeenCalled();
    });

    it('two people in the same part: nothing lost, "compare and choose", saved on the newest revision', async () => {
        const parts = [{ kind: 'conflict', key: 'pricing/0', label: 'Pricing', base: '<p>b</p>', mine: '<p>edited</p>', theirs: '<p>their price</p>' }];
        api.updateDocument.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, code: 'document_conflict', conflict: { currentVersionId: 'v5', parts } }));
        open();
        const u = user();
        await u.click(await screen.findByRole('button', { name: 'type in the frame' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
        expect(await screen.findByTestId('document-conflict')).toHaveTextContent('Nothing is lost');
        await u.click(within(screen.getByTestId('document-conflict')).getByRole('button', { name: 'Compare and choose' }));
        const dialog = await screen.findByRole('dialog', { name: 'Compare and choose' });
        expect(within(dialog).getByText('their price')).toBeInTheDocument();
        await u.click(within(dialog).getByRole('radio', { name: /Saved meanwhile/ }));
        await u.click(within(dialog).getByTestId('conflict-save'));
        await waitFor(() => expect(api.updateDocument).toHaveBeenLastCalledWith('d1', { bodyHtml: '<p>their price</p>', expectedVersionId: 'v5', merge: true }));
        await waitFor(() => expect(screen.queryByTestId('document-conflict')).not.toBeInTheDocument());
    });

    it('downloads the PDF only after what was typed is saved', async () => {
        api.downloadPdf.mockResolvedValue({ degraded: false });
        open();
        const u = user();
        await u.click(await screen.findByRole('button', { name: 'type in the frame' }));
        await u.click(screen.getByTestId('document-download-pdf'));
        await waitFor(() => expect(api.downloadPdf).toHaveBeenCalled());
        expect(canvas.flush).toHaveBeenCalled();
        expect(api.updateDocument.mock.invocationCallOrder[0]).toBeLessThan(api.downloadPdf.mock.invocationCallOrder[0]);
    });

    it('a render failure is said, not swallowed', async () => {
        api.downloadPdf.mockRejectedValue(new Error('Styled PDF rendering is unavailable.'));
        open();
        await user().click(await screen.findByTestId('document-download-pdf'));
        expect(await screen.findByTestId('document-error')).toHaveTextContent('Styled PDF rendering is unavailable.');
    });

    it('turning the house style off merges into the settings instead of replacing them', async () => {
        open({ settings: { design: { preset: 'formal' } } as never });
        await user().click(await screen.findByTestId('document-house-style-toggle'));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', { settings: { design: { preset: 'formal' }, houseStyle: false }, expectedVersionId: 'v1' }));
    });
});

describe('DocumentEditor: somebody else in the same section', () => {
    it('shows who is here and says so, calmly, when they are in the section being typed in', async () => {
        api.postPresence.mockResolvedValue({ peers: [{ userId: 'anna', clientId: 'c-anna', sectionId: 'pricing', state: 'editing' }], people: { anna: { name: 'Anna de Vries' } }, ttlMs: 45000 });
        open({ projectId: 'p1' });
        const u = user();
        await u.click(await screen.findByRole('button', { name: 'report outline' }));
        const avatars = await screen.findByTestId('document-presence');
        expect(within(avatars).getByText('Anna de Vries is editing Pricing')).toBeInTheDocument();
        expect(JSON.parse(screen.getByTestId('fake-canvas').getAttribute('data-peers') || '[]')).toEqual([
            expect.objectContaining({ sectionId: 'pricing', label: 'Anna de Vries is editing' }),
        ]);
        expect(screen.queryByTestId('document-soft-lock')).not.toBeInTheDocument();
        await u.click(screen.getByRole('button', { name: 'caret into pricing' }));
        expect(await screen.findByTestId('document-soft-lock')).toHaveTextContent('Anna de Vries is also editing Pricing');
    });

    it('a private document asks nobody who else is here', async () => {
        open();
        await screen.findByTestId('fake-canvas');
        expect(api.postPresence).not.toHaveBeenCalled();
    });
});

describe('DocumentEditor: panels and keys', () => {
    it('opens the history, and comments only for a document in a project', async () => {
        open({ projectId: 'p1' });
        const u = user();
        await u.click(await screen.findByTestId('document-history-toggle'));
        expect(screen.getByTestId('history-stub')).toBeInTheDocument();
        await u.click(screen.getByTestId('document-comments-toggle'));
        expect(screen.getByTestId('comments-stub')).toBeInTheDocument();
    });

    it('Ctrl+Shift+H opens the history and Ctrl+/ lists the shortcuts', async () => {
        open();
        await screen.findByTestId('fake-canvas');
        const u = user();
        await u.keyboard('{Control>}{Shift>}H{/Shift}{/Control}');
        expect(screen.getByTestId('history-stub')).toBeInTheDocument();
        await u.keyboard('{Control>}/{/Control}');
        expect(await screen.findByTestId('document-shortcuts')).toBeInTheDocument();
    });
});

describe('DocumentEditor: a presentation', () => {
    it('opens a blank one straight into its outline; typing redraws the slides as a draft and saves the outline', async () => {
        api.previewDeckDraft.mockResolvedValue('<html>slides</html>');
        open({ docType: 'presentation', bodyHtml: '' });
        const u = user();
        const outline = await screen.findByTestId('deck-outline');
        await u.type(outline, '# Kick-off');
        await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
        await waitFor(() => expect(canvas.setDraft).toHaveBeenCalledWith('<html>slides</html>'));
        expect(api.previewDeckDraft).toHaveBeenLastCalledWith('d1', { bodyHtml: '# Kick-off' }, expect.anything());
        expect(api.updateDocument).toHaveBeenLastCalledWith('d1', expect.objectContaining({ bodyHtml: '# Kick-off' }));
    });

    it('moving the caret in the outline shows its slide', async () => {
        open({ docType: 'presentation', bodyHtml: '' });
        const u = user();
        const outline = await screen.findByTestId('deck-outline');
        await u.type(outline, '# Deck{Enter}## One{Enter}## Two');
        expect(canvas.goto).toHaveBeenLastCalledWith(2);
    });

    it('offers PowerPoint and the PDF, and hides find and the outline panel', async () => {
        api.downloadPptx.mockResolvedValue({ degraded: false });
        open({ docType: 'presentation', bodyHtml: '# Deck\n## One' });
        await user().click(await screen.findByTestId('document-download-pptx'));
        await waitFor(() => expect(api.downloadPptx).toHaveBeenCalledWith('d1', 'Offer', 'v1'));
        expect(canvas.flush).not.toHaveBeenCalled();
        expect(screen.getByTestId('document-download-pdf')).toHaveTextContent('PDF');
        expect(screen.queryByTestId('document-outline-toggle')).not.toBeInTheDocument();
    });
});
