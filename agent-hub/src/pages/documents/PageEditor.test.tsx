import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * A page, in its two ways of being written:
 *   - filed in a project: live together (useCollab); the editor is bound to
 *     the shared document, nobody saves anything, the presence chip shows;
 *   - on its own, or when live editing is switched off: saved by revision
 *     (merged with what others saved), with a save status.
 * And a viewer reads.
 */

const { api, collab, editorProps } = vi.hoisted(() => ({
    api: { updateDocument: vi.fn(), getDocument: vi.fn(), downloadPdf: vi.fn(), fetchRendered: vi.fn() },
    collab: { useCollab: vi.fn() },
    editorProps: { last: null as Record<string, any> | null, history: null as Record<string, any> | null, replaceDocument: vi.fn(), setContent: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../editor/collab/useCollab', () => ({ default: collab.useCollab }));
vi.mock('../../editor/react/RichTextEditor', async () => {
    const R = await import('react');
    const Fake = R.forwardRef<unknown, Record<string, any>>((props, ref) => {
        editorProps.last = props;
        R.useImperativeHandle(ref, () => ({
            flush: () => null, setContent: editorProps.setContent, replaceDocument: editorProps.replaceDocument, openFind: vi.fn(), scrollToHeading: vi.fn(),
            getEditor: () => ({ getText: () => 'shown', getHTML: () => '<p>shown in the editor</p>' }),
        }));
        return (
            <div data-testid="rich-editor" data-editable={String(props.editable)} data-live={String(!!props.collab)}>
                <button type="button" onClick={() => props.onSave?.('<p>typed</p>')}>save from editor</button>
                <button type="button" onClick={() => props.onTocUpdate?.([{ textContent: 'Agenda', level: 1, itemIndex: 0 }])}>headings</button>
            </div>
        );
    });
    return { default: Fake };
});
vi.mock('../../components/versions/VersionHistoryPanel', () => ({
    default: (props: Record<string, any>) => { editorProps.history = props; return <div data-testid="history-stub" />; },
}));
vi.mock('../../components/comments/CommentsPanel', () => ({ default: () => <div data-testid="comments-stub" /> }));

const { default: PageEditor } = await import('./PageEditor');

const PAGE = { id: 'pg1', userId: 'me', name: 'Minutes', docType: 'page', bodyHtml: '<p>a</p>', css: '', settings: {}, versionId: 'v1', editable: true, projectId: 'p1' as string | null };
const ME = { id: 'me', name: 'Me' };
const handle = (status: string, canEdit = true) => ({ status, canEdit, ready: status === 'synced', ydoc: {}, fragment: {}, awareness: {}, peers: [], userId: 'me', destroy: vi.fn() });

function open(page: Partial<typeof PAGE> = {}) {
    return render(withQueryClient(<PageEditor initial={{ ...PAGE, ...page } as never} people={{}} variant="page" currentUser={ME} onBack={vi.fn()} />));
}

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    collab.useCollab.mockReset();
    editorProps.last = null;
    editorProps.history = null;
    editorProps.replaceDocument.mockReset();
    editorProps.setContent.mockReset();
    sessionStorage.clear();
    api.updateDocument.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...PAGE, ...patch, versionId: 'v2' }));
});

describe('PageEditor: live together in a project', () => {
    it('joins the live session and hands it to the editor; typing saves nothing itself', async () => {
        collab.useCollab.mockReturnValue(handle('synced'));
        open();
        expect(collab.useCollab).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', kind: 'document', resourceId: 'pg1', enabled: true, user: ME }));
        expect(screen.getByTestId('page-editor')).toHaveAttribute('data-live', 'true');
        expect(screen.getByTestId('rich-editor')).toHaveAttribute('data-live', 'true');
        expect(screen.getByText('Live')).toBeInTheDocument();
        expect(screen.queryByTestId('document-save-state')).not.toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'save from editor' }));
        expect(api.updateDocument).not.toHaveBeenCalled();
    });

    it('a restore is not checked against a revision: checkpoints move it while people type', async () => {
        collab.useCollab.mockReturnValue(handle('synced'));
        open();
        await userEvent.setup().click(screen.getByTestId('document-history-toggle'));
        expect(editorProps.history).toMatchObject({ baseUrl: '/api/studio-documents/pg1', expectedVersion: null, canEdit: true });
    });

    it('a viewer reads along', () => {
        collab.useCollab.mockReturnValue(handle('readonly', false));
        open({ editable: false, projectRole: 'viewer' } as never);
        expect(screen.getByTestId('rich-editor')).toHaveAttribute('data-editable', 'false');
        expect(screen.getByTestId('document-read-only')).toBeInTheDocument();
    });

    it('when live editing is switched off, the page is saved by revision instead', async () => {
        collab.useCollab.mockReturnValue(handle('disabled'));
        open();
        expect(screen.getByTestId('rich-editor')).toHaveAttribute('data-live', 'false');
        await userEvent.setup().click(screen.getByRole('button', { name: 'save from editor' }));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('pg1', { bodyHtml: '<p>typed</p>', expectedVersionId: 'v1', merge: true }));
        expect(await screen.findByTestId('document-save-state')).toHaveTextContent(/Saved/);
    });
});

describe('PageEditor: the page went live while it was saved by revision', () => {
    it('the refused text is kept in the history, the page joins the live session, and the notice leads to the copy', async () => {
        const retry = vi.fn();
        collab.useCollab.mockReturnValue({ ...handle('disabled'), retry });
        api.updateDocument.mockRejectedValueOnce(Object.assign(new Error('This page is being edited live.'), { status: 409, code: 'document_live', conflictVersionId: 'kept-1' }));
        open();
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'save from editor' }));
        expect(await screen.findByTestId('document-kept-live')).toHaveTextContent(/kept in its version history/);
        expect(retry).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('document-error')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Open the history' }));
        expect(editorProps.history).not.toBeNull();
        expect(screen.queryByTestId('document-kept-live')).not.toBeInTheDocument();
    });

    it('a live session that ended before its last edits were confirmed: the editor\'s text goes in as one save', async () => {
        collab.useCollab.mockReturnValue({ ...handle('disabled'), ready: true, unsent: true });
        open();
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('pg1', { bodyHtml: '<p>shown in the editor</p>', expectedVersionId: 'v1', merge: true }));
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
    });

    it('a session that ended with everything confirmed saves nothing by itself', async () => {
        collab.useCollab.mockReturnValue({ ...handle('disabled'), ready: true, unsent: false });
        open();
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(api.updateDocument).not.toHaveBeenCalled();
    });

    it('a draft left from an earlier visit is offered and goes back in as a late save', async () => {
        sessionStorage.setItem('document-draft:pg1', JSON.stringify({ html: '<p>left over</p>', base: 'v0', at: Date.now() }));
        collab.useCollab.mockReturnValue(null);
        open({ projectId: null });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Put them back' }));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('pg1', { bodyHtml: '<p>left over</p>', expectedVersionId: 'v0', merge: true }));
        await waitFor(() => expect(editorProps.replaceDocument).toHaveBeenCalledWith('<p>left over</p>'));
        expect(screen.queryByTestId('document-recovery')).not.toBeInTheDocument();
    });
});

describe('PageEditor: a page of one\'s own', () => {
    it('a restore is checked against the revision on screen', async () => {
        collab.useCollab.mockReturnValue(null);
        open({ projectId: null });
        await userEvent.setup().click(screen.getByTestId('document-history-toggle'));
        expect(editorProps.history).toMatchObject({ expectedVersion: 'v1' });
    });

    it('does not try to go live, and saves by revision', async () => {
        collab.useCollab.mockReturnValue(null);
        open({ projectId: null });
        expect(collab.useCollab).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
        expect(screen.queryByTestId('document-comments-toggle')).not.toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'save from editor' }));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1));
    });

    it('builds its outline from the headings, and prints the PDF in a tab of its own', async () => {
        collab.useCollab.mockReturnValue(null);
        api.fetchRendered.mockResolvedValue({ blob: new Blob(['%PDF']), degraded: false });
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
        URL.createObjectURL = vi.fn(() => 'blob:pdf');
        URL.revokeObjectURL = vi.fn();
        open({ projectId: null });
        const u = userEvent.setup();
        await u.click(screen.getByRole('button', { name: 'headings' }));
        await u.click(screen.getByTestId('document-outline-toggle'));
        expect(screen.getByTestId('document-outline')).toHaveTextContent('Agenda');
        await u.click(screen.getByTestId('document-print'));
        await waitFor(() => expect(openSpy).toHaveBeenCalledWith('blob:pdf', '_blank'));
        openSpy.mockRestore();
    });

    it('an image is carried in the page itself, and a large one is refused', async () => {
        collab.useCollab.mockReturnValue(null);
        open({ projectId: null });
        const upload = editorProps.last?.onUploadImage as (f: File) => Promise<{ src: string }>;
        await expect(upload(new File(['x'], 'logo.png', { type: 'image/png' }))).resolves.toEqual(expect.objectContaining({ src: expect.stringMatching(/^data:image\/png;base64,/) }));
        await expect(upload(new File([new Uint8Array(400 * 1024)], 'big.png', { type: 'image/png' }))).rejects.toThrow('image_too_large');
        // Saved by revision a page takes up to 300 KB per picture.
        await expect(upload(new File([new Uint8Array(250 * 1024)], 'mid.png', { type: 'image/png' }))).resolves.toEqual(expect.objectContaining({ src: expect.stringMatching(/^data:image\/png;base64,/) }));
    });

    it('live together, a picture has the same 300 KB cap as a page saved by revision', async () => {
        // This used to be a lower live cap (180 KB) because the server refused
        // one co-editing update over 256 KB. The server now takes a single
        // update of up to 576 KB (core/collab/limits maxUpdateBytes), sized to
        // carry a 300 KB picture as base64, so a live page takes what a page
        // saved by revision takes, and still refuses what is larger.
        collab.useCollab.mockReturnValue(handle('synced'));
        open();
        const upload = editorProps.last?.onUploadImage as (f: File) => Promise<{ src: string }>;
        await expect(upload(new File([new Uint8Array(150 * 1024)], 'ok.png', { type: 'image/png' }))).resolves.toEqual(expect.objectContaining({ src: expect.stringMatching(/^data:image\/png;base64,/) }));
        await expect(upload(new File([new Uint8Array(250 * 1024)], 'mid.png', { type: 'image/png' }))).resolves.toEqual(expect.objectContaining({ src: expect.stringMatching(/^data:image\/png;base64,/) }));
        await expect(upload(new File([new Uint8Array(300 * 1024 + 1)], 'big.png', { type: 'image/png' }))).rejects.toThrow('image_too_large');
    });
});

describe('PageEditor: the assistant edited it', () => {
    it('a page saved by revision reads the new text', async () => {
        collab.useCollab.mockReturnValue(null);
        api.getDocument.mockResolvedValue({ ...PAGE, bodyHtml: '<p>by the assistant</p>', versionId: 'v3' });
        open({ projectId: null });
        await act(async () => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId: 'pg1' } })); });
        await waitFor(() => expect(api.getDocument).toHaveBeenCalledWith('pg1'));
        // One undoable step that keeps the caret: Ctrl+Z takes the edit back.
        await waitFor(() => expect(editorProps.replaceDocument).toHaveBeenCalledWith('<p>by the assistant</p>'));
        expect(editorProps.setContent).not.toHaveBeenCalled();
    });
});
