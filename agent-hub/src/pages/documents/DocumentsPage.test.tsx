import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * The library: loading, failed and empty are different screens; the list on
 * screen stays while the next page or search loads; totals and a pager;
 * archiving and deleting a folder ask first; the archive has a way back;
 * owner and last editor are named; a new page is one click.
 */

const { api, client } = vi.hoisted(() => ({
    api: {
        listDocumentsPage: vi.fn(), documentRequest: vi.fn(), createDocument: vi.fn(), deleteDocument: vi.fn(),
        unarchiveDocument: vi.fn(), updateDocument: vi.fn(),
    },
    client: { get: vi.fn() },
}));
vi.mock('./documentsApi', () => api);
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiClient: client, default: client }));
vi.mock('./DocumentEditor', () => ({ default: ({ documentId }: { documentId: string }) => <div data-testid="editor-stub">editor {documentId}</div> }));
vi.mock('./HouseStylePanel', () => ({ default: () => <div data-testid="house-style-stub" /> }));

const { default: DocumentsPage } = await import('./DocumentsPage');

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Doc ${id}`, userId: 'me', docType: 'letter', versionId: `v-${id}`, updatedAt: new Date().toISOString(), ...extra });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    client.get.mockReset().mockResolvedValue({ user: { id: 'me', displayName: 'Me' } });
    api.documentRequest.mockImplementation(async (path: string) => {
        if (path === '/folders') return { folders: [{ id: 'f1', name: 'Customers', parentId: null }] };
        if (path.startsWith('/starters')) return { starters: [] };
        return {};
    });
    api.listDocumentsPage.mockResolvedValue({ documents: [row('a'), row('b', { userId: 'anna', updatedBy: 'ben', docType: 'page' })], total: 2, people: { anna: { name: 'Anna' }, ben: {} } });
});

const renderPage = () => render(withQueryClient(<DocumentsPage />));

describe('DocumentsPage: states', () => {
    it('shows placeholders while the first page loads, then the rows with owner and last editor', async () => {
        const first = deferred<unknown>();
        api.listDocumentsPage.mockReturnValueOnce(first.promise);
        renderPage();
        expect(screen.getByRole('status', { name: 'Loading documents…' })).toBeInTheDocument();
        await act(async () => { first.resolve({ documents: [row('a'), row('b', { userId: 'anna', updatedBy: 'ben', docType: 'page' })], total: 2, people: { anna: { name: 'Anna' } } }); });
        expect(await screen.findByTestId('library-row-a')).toHaveTextContent('Letter · You');
        expect(screen.getByTestId('library-row-b')).toHaveTextContent('Page · Anna');
        expect(screen.getByTestId('library-row-b')).toHaveTextContent('edited by Former member');
    });

    it('says the list could not be loaded, and tries again', async () => {
        api.listDocumentsPage.mockRejectedValueOnce(new Error('boom'));
        renderPage();
        expect(await screen.findByRole('alert')).toHaveTextContent('The documents could not be loaded.');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('library-row-a')).toBeInTheDocument();
    });

    it('an empty library explains itself and offers to start one', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [], total: 0, people: {} });
        renderPage();
        expect(await screen.findByText('No documents here yet')).toBeInTheDocument();
    });

    it('keeps the list on screen while a search loads, and pages with a total', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('a')], total: 41, people: {} });
        renderPage();
        expect(await screen.findByTestId('documents-pager-range')).toHaveTextContent('Rows 1–30 of 41');
        const next = deferred<unknown>();
        api.listDocumentsPage.mockReturnValueOnce(next.promise);
        const u = userEvent.setup();
        await u.type(screen.getByRole('textbox', { name: 'Search documents' }), 'plan');
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'plan', offset: 0 })));
        expect(screen.getByTestId('library-row-a')).toBeInTheDocument();
        expect(screen.getByTestId('library-list')).toHaveAttribute('aria-busy', 'true');
        await act(async () => { next.resolve({ documents: [row('p')], total: 1, people: {} }); });
        expect(await screen.findByTestId('library-row-p')).toBeInTheDocument();
    });
});

describe('DocumentsPage: actions that ask first', () => {
    it('archives only after a confirmation that says what happens', async () => {
        api.deleteDocument.mockResolvedValue(true);
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: 'Archive Doc a' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('You can restore it from Archived');
        expect(api.deleteDocument).not.toHaveBeenCalled();
        await u.click(within(dialog).getByRole('button', { name: 'Archive' }));
        await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith('a'));
    });

    it('only the owner is offered archiving', async () => {
        renderPage();
        await screen.findByTestId('library-row-b');
        expect(screen.queryByRole('button', { name: 'Archive Doc b' })).not.toBeInTheDocument();
    });

    it('the archive lists what was archived and brings it back', async () => {
        api.unarchiveDocument.mockResolvedValue({ id: 'a' });
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-a');
        await u.click(screen.getByTestId('documents-archived-view'));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ archived: '1' })));
        await u.click(await screen.findByTestId('library-unarchive-a'));
        await waitFor(() => expect(api.unarchiveDocument).toHaveBeenCalledWith('a'));
    });

    it('deleting a folder asks first and says its documents move up', async () => {
        api.documentRequest.mockImplementation(async (path: string, _data: unknown, method?: string) => {
            if (path === '/folders') return { folders: [{ id: 'f1', name: 'Customers', parentId: null }] };
            if (method === 'DELETE') return { ok: true };
            return {};
        });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: /Customers/ }));
        await u.click(screen.getByRole('button', { name: 'Delete folder Customers' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('move up one level');
        await u.click(within(dialog).getByRole('button', { name: 'Delete folder' }));
        await waitFor(() => expect(api.documentRequest).toHaveBeenCalledWith('/folders/f1', undefined, 'DELETE'));
    });
});

describe('DocumentsPage: starting one', () => {
    it('a page is one click from the gallery, and opens straight away', async () => {
        api.createDocument.mockResolvedValue({ id: 'new-page' });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByTestId('documents-new'));
        await u.click(await screen.findByTestId('documents-new-page'));
        await waitFor(() => expect(api.createDocument).toHaveBeenCalledWith(expect.objectContaining({ docType: 'page', name: 'Untitled page', kind: 'document' })));
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor new-page');
    });
});
