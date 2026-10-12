import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * A notebook is a document type: it is a row in the library (with its source
 * count), a type to filter on and a tile in the gallery, but only for a reader
 * the server lists notebooks for; it opens the notebook workspace in place,
 * is filed through its own route, and is deleted (never archived) after a
 * confirmation that says so.
 */

const { api, notebookApi, client } = vi.hoisted(() => ({
    api: {
        listDocumentsPage: vi.fn(), documentRequest: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(),
        unarchiveDocument: vi.fn(), updateDocument: vi.fn(),
    },
    notebookApi: vi.fn(),
    client: { get: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('./notebook/hooks/notebookApi', () => ({ notebookApi }));
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiClient: client, default: client }));
vi.mock('./DocumentEditor', () => ({ default: ({ documentId }: { documentId: string }) => <div data-testid="editor-stub">editor {documentId}</div> }));
vi.mock('./HouseStylePanel', () => ({ default: () => <div data-testid="house-style-stub" /> }));
vi.mock('./notebook/detail/NotebookDetail', () => ({
    default: ({ notebookId, onBack }: { notebookId: string; onBack: () => void }) => (
        <div data-testid="notebook-stub">notebook {notebookId}<button type="button" onClick={onBack}>back</button></div>
    ),
}));

const { default: DocumentsPage } = await import('./DocumentsPage');

const notebookRow = { id: 'nb1', name: 'Market research', userId: 'me', docType: 'notebook', kind: 'document', visibility: 'private', sourceCount: 3, updatedAt: new Date().toISOString() };
const docRow = { id: 'd1', name: 'Offer', userId: 'me', docType: 'letter', versionId: 'v1', updatedAt: new Date().toISOString() };

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    notebookApi.mockReset();
    client.get.mockReset().mockResolvedValue({ user: { id: 'me', displayName: 'Me' } });
    api.documentRequest.mockImplementation(async (path: string) => {
        if (path === '/folders') return { folders: [{ id: 'f1', name: 'Customers', parentId: null }] };
        if (path.startsWith('/starters')) return { starters: [] };
        return {};
    });
    api.listDocumentsPage.mockResolvedValue({ documents: [notebookRow, docRow], total: 2, people: {}, notebooks: true });
});

const renderPage = (props: Record<string, unknown> = {}) => render(withQueryClient(<DocumentsPage {...props} />));

describe('DocumentsPage: notebooks in the library', () => {
    it('lists a notebook as a document of type Notebook, with its sources, and no copy', async () => {
        renderPage();
        const row = await screen.findByTestId('library-row-nb1');
        expect(row).toHaveTextContent('Notebook · 3 sources · You');
        expect(within(row).queryByRole('button', { name: 'Make a copy of Market research' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Make a copy of Offer' })).toBeInTheDocument();
    });

    it('opens a notebook in place, and back returns to the library', async () => {
        const onDocumentChange = vi.fn();
        renderPage({ onDocumentChange });
        const u = userEvent.setup();
        await u.click(await screen.findByText('Market research'));
        expect(await screen.findByTestId('notebook-stub')).toHaveTextContent('notebook nb1');
        expect(onDocumentChange).toHaveBeenLastCalledWith('notebook/nb1');
        await u.click(screen.getByRole('button', { name: 'back' }));
        expect(await screen.findByTestId('library-row-nb1')).toBeInTheDocument();
        expect(onDocumentChange).toHaveBeenLastCalledWith(null);
    });

    it('a notebook link opens that notebook straight away', async () => {
        renderPage({ initialDocumentId: 'notebook/nb9' });
        expect(await screen.findByTestId('notebook-stub')).toHaveTextContent('notebook nb9');
    });

    it('deletes a notebook for good, only after a confirmation that says so', async () => {
        notebookApi.mockResolvedValue({ success: true });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: 'Delete Market research' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('cannot be restored');
        expect(notebookApi).not.toHaveBeenCalled();
        await u.click(within(dialog).getByRole('button', { name: 'Delete notebook' }));
        await waitFor(() => expect(notebookApi).toHaveBeenCalledWith('/nb1', { method: 'DELETE' }));
        expect(api.deleteDocument).not.toHaveBeenCalled();
    });

    it('files a notebook through its own route when documents are moved together', async () => {
        api.updateDocument.mockResolvedValue({});
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('checkbox', { name: 'Select Market research' }));
        await u.click(screen.getByRole('checkbox', { name: 'Select Offer' }));
        await u.selectOptions(screen.getByRole('combobox', { name: 'Move to folder' }), 'f1');
        await waitFor(() => expect(api.documentRequest).toHaveBeenCalledWith('/notebooks/nb1/filing', { folderId: 'f1' }, 'PATCH'));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('d1', { folderId: 'f1', expectedVersionId: 'v1' }));
    });

    it('filters on the Notebook type', async () => {
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByTestId('documents-format-filter-notebook'));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ docType: 'notebook' })));
        // Templates hold no notebooks: the type is no filter there.
        await u.click(screen.getByTestId('documents-view-template'));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'template', docType: undefined })));
        expect(screen.queryByTestId('documents-format-filter-notebook')).not.toBeInTheDocument();
    });
});

describe('DocumentsPage: starting a notebook', () => {
    it('makes a notebook from the gallery, in the open folder, and opens it', async () => {
        notebookApi.mockResolvedValue({ success: true, notebook: { id: 'nb-new' } });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: /Customers/ }));
        await u.click(screen.getByTestId('documents-new'));
        await u.click(await screen.findByTestId('documents-new-notebook'));
        await waitFor(() => expect(notebookApi).toHaveBeenCalledWith('/', { method: 'POST', body: JSON.stringify({ name: 'Untitled notebook' }) }));
        await waitFor(() => expect(api.documentRequest).toHaveBeenCalledWith('/notebooks/nb-new/filing', { folderId: 'f1' }, 'PATCH'));
        expect(await screen.findByTestId('notebook-stub')).toHaveTextContent('notebook nb-new');
    });

    it('offers no notebook to a reader the server does not list notebooks for', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [docRow], total: 1, people: {}, notebooks: false });
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-d1');
        expect(screen.queryByTestId('documents-format-filter-notebook')).not.toBeInTheDocument();
        await u.click(screen.getByTestId('documents-new'));
        expect(await screen.findByTestId('documents-new-page')).toBeInTheDocument();
        expect(screen.queryByTestId('documents-new-notebook')).not.toBeInTheDocument();
    });
});
