import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * A spreadsheet is a document type for a reader who may use datatables: a row
 * with its own icon and label, a type to filter on, a tile in the gallery that
 * starts one (the server makes its table) in the open folder and opens it.
 */

const { api, client } = vi.hoisted(() => ({
    api: {
        listDocumentsPage: vi.fn(), documentRequest: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(),
        unarchiveDocument: vi.fn(), updateDocument: vi.fn(), createSpreadsheet: vi.fn(),
    },
    client: { get: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiClient: client, default: client }));
vi.mock('./DocumentEditor', () => ({ default: ({ documentId }: { documentId: string }) => <div data-testid="editor-stub">editor {documentId}</div> }));
vi.mock('./HouseStylePanel', () => ({ default: () => <div /> }));

const { default: DocumentsPage } = await import('./DocumentsPage');

const sheetRow = { id: 's1', name: 'Budget', userId: 'me', docType: 'spreadsheet', kind: 'document', versionId: 'v1', updatedAt: new Date().toISOString() };

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    client.get.mockReset().mockResolvedValue({ user: { id: 'me', displayName: 'Me' } });
    api.documentRequest.mockImplementation(async (path: string) => {
        if (path === '/folders') return { folders: [{ id: 'f1', name: 'Finance', parentId: null }] };
        if (path.startsWith('/starters')) return { starters: [] };
        return {};
    });
    api.listDocumentsPage.mockResolvedValue({ documents: [sheetRow], total: 1, people: {}, notebooks: false, spreadsheets: true });
});

const renderPage = () => render(withQueryClient(<DocumentsPage />));

describe('DocumentsPage: spreadsheets', () => {
    it('lists a spreadsheet as its own type and opens it in the editor', async () => {
        renderPage();
        const row = await screen.findByTestId('library-row-s1');
        expect(row).toHaveTextContent('Spreadsheet · You');
        await userEvent.setup().click(within(row).getByText('Budget'));
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor s1');
    });

    it('starts a spreadsheet from the gallery, in the open folder', async () => {
        api.createSpreadsheet.mockResolvedValue({ id: 's-new' });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: /Finance/ }));
        await u.click(screen.getByTestId('documents-new'));
        await u.click(await screen.findByTestId('documents-new-spreadsheet'));
        await waitFor(() => expect(api.createSpreadsheet).toHaveBeenCalledWith({ name: 'Untitled spreadsheet', folderId: 'f1' }));
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor s-new');
    });

    it('filters on the Spreadsheet type', async () => {
        renderPage();
        await userEvent.setup().click(await screen.findByTestId('documents-format-filter-spreadsheet'));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ docType: 'spreadsheet' })));
    });

    it('offers no spreadsheet to a reader without datatables', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [], total: 0, people: {}, notebooks: false, spreadsheets: false });
        renderPage();
        const u = userEvent.setup();
        await screen.findByText('No documents here yet');
        expect(screen.queryByTestId('documents-format-filter-spreadsheet')).not.toBeInTheDocument();
        await u.click(screen.getByTestId('documents-new'));
        expect(await screen.findByTestId('documents-new-page')).toBeInTheDocument();
        expect(screen.queryByTestId('documents-new-spreadsheet')).not.toBeInTheDocument();
    });
});
