import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * The library: loading, failed and empty are different screens; the list on
 * screen stays while the next page or search loads; totals and a pager;
 * archiving and deleting a folder ask first; the archive has a way back;
 * owner and last editor are named; a new page is one click. The intro names
 * only what this reader can make; the gallery copies one of the reader's own
 * templates; a shared row says "Shared"; categories are added, and cleared
 * only after a confirmation.
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
const TEMPLATE = { id: 'tpl-1', name: 'Welcome letter', docType: 'letter', kind: 'template' };
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    client.get.mockReset().mockImplementation(async (path: string) => (path === '/api/studio-documents'
        ? { documents: [TEMPLATE], spreadsheets: false }
        : { user: { id: 'me', displayName: 'Me' } }));
    api.documentRequest.mockImplementation(async (path: string) => {
        if (path === '/folders') return { folders: [{ id: 'f1', name: 'Customers', parentId: null }] };
        if (path.startsWith('/starters')) return { starters: [] };
        if (path === '/tpl-1/duplicate') return { document: { id: 'from-tpl' } };
        return {};
    });
    api.listDocumentsPage.mockResolvedValue({ documents: [row('a'), row('b', { userId: 'anna', updatedBy: 'ben', docType: 'page' })], total: 2, people: { anna: { name: 'Anna' }, ben: {} } });
});

const renderPage = () => render(withQueryClient(<DocumentsPage />));

describe('DocumentsPage: workspace and Studio management', () => {
    it('opens owned and shared documents without offering house-style management', async () => {
        const onDocumentChange = vi.fn();
        render(withQueryClient(<DocumentsPage onDocumentChange={onDocumentChange} user={{ id: 'me', permissions: ['page_chat'] }} />));
        await screen.findByTestId('library-row-a');
        expect(screen.queryByTestId('documents-house-style')).not.toBeInTheDocument();
        expect(screen.getByTestId('documents-new')).toBeInTheDocument();
        await userEvent.click(within(screen.getByTestId('library-row-b')).getByRole('button', { name: /^Doc b/ }));
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor b');
        expect(onDocumentChange).toHaveBeenCalledWith('b');
    });

    it('offers house style in Studio and removes the panel on return to workspace mode', async () => {
        const view = render(withQueryClient(<DocumentsPage mode="studio" />));
        await userEvent.click(await screen.findByTestId('documents-house-style'));
        expect(screen.getByTestId('house-style-stub')).toBeInTheDocument();
        view.rerender(withQueryClient(<DocumentsPage mode="workspace" />));
        expect(await screen.findByTestId('documents-library')).toBeInTheDocument();
        expect(screen.queryByTestId('documents-house-style')).not.toBeInTheDocument();
        expect(screen.queryByTestId('house-style-stub')).not.toBeInTheDocument();
    });
});

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

describe('DocumentsPage: the archive is one view', () => {
    it('lists every kind when archived, and labels templates and sections', async () => {
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-a');
        await u.click(within(screen.getByTestId('documents-view')).getByRole('button', { name: /Templates/ }));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'template' })));
        api.listDocumentsPage.mockResolvedValue({ documents: [row('t', { kind: 'template' }), row('s', { kind: 'section' }), row('d', { kind: 'document' })], total: 3, people: {} });
        await u.click(screen.getByTestId('documents-archived-view'));
        await waitFor(() => expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ archived: '1' })));
        expect(api.listDocumentsPage.mock.lastCall?.[0]).not.toHaveProperty('kind');
        expect(await screen.findByTestId('library-kind-t')).toHaveTextContent('Template');
        expect(screen.getByTestId('library-kind-s')).toHaveTextContent('Reusable section');
        expect(screen.queryByTestId('library-kind-d')).not.toBeInTheDocument();
    });
});

describe('DocumentsPage: filing several at once', () => {
    it('offers a checkbox only on rows the reader owns', async () => {
        renderPage();
        await screen.findByTestId('library-row-b');
        expect(screen.getByRole('checkbox', { name: 'Select Doc a' })).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: 'Select Doc b' })).not.toBeInTheDocument();
    });

    it('moves without a revision check, goes on past a refusal and says how many moved', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('a'), row('c')], total: 2, people: {} });
        api.updateDocument.mockImplementation(async (id: string) => { if (id === 'a') throw new Error('nope'); return {}; });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('checkbox', { name: 'Select Doc a' }));
        await u.click(screen.getByRole('checkbox', { name: 'Select Doc c' }));
        await u.selectOptions(screen.getByRole('combobox', { name: 'Move to folder' }), 'f1');
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('c', { folderId: 'f1' }));
        expect(api.updateDocument).toHaveBeenCalledWith('a', { folderId: 'f1' });
        expect(await screen.findByRole('alert')).toHaveTextContent('Moved 1 of 2; 1 could not be moved.');
    });
});

describe('DocumentsPage: what each row offers', () => {
    it('offers no copy of a spreadsheet to a reader who may not start spreadsheets', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('s', { docType: 'spreadsheet' }), row('a')], total: 2, people: {}, spreadsheets: false });
        renderPage();
        await screen.findByTestId('library-row-s');
        expect(screen.queryByRole('button', { name: 'Make a copy of Doc s' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Make a copy of Doc a' })).toBeInTheDocument();
    });

    it('offers an organisation admin to archive a team template of someone else', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('t', { userId: 'anna', kind: 'template', visibility: 'team' }), row('p', { userId: 'anna', kind: 'document', visibility: 'team' })], total: 2, people: {} });
        render(withQueryClient(<DocumentsPage user={{ id: 'me', orgRole: 'org_admin' }} />));
        await screen.findByTestId('library-row-t');
        expect(screen.getByRole('button', { name: 'Archive Doc t' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Archive Doc p' })).not.toBeInTheDocument();
    });

    it('steps back a page when archiving empties the last one', async () => {
        let archived = false;
        api.deleteDocument.mockImplementation(async () => { archived = true; return true; });
        api.listDocumentsPage.mockImplementation(async ({ offset }: { offset: number }) => (offset === 30
            ? { documents: archived ? [] : [row('z')], total: archived ? 30 : 31, people: {} }
            : { documents: [row('a')], total: archived ? 30 : 31, people: {} }));
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-a');
        await u.click(screen.getByTestId('documents-pager-next'));
        await u.click(await screen.findByRole('button', { name: 'Archive Doc z' }));
        await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }));
        expect(await screen.findByTestId('library-row-a')).toBeInTheDocument();
        expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
        expect(screen.queryByText('No documents here yet')).not.toBeInTheDocument();
    });

    it('stays in a folder whose delete failed', async () => {
        api.documentRequest.mockImplementation(async (path: string, _data: unknown, method?: string) => {
            if (path === '/folders') return { folders: [{ id: 'f1', name: 'Customers', parentId: null }] };
            if (method === 'DELETE') throw new Error('Folder not found');
            return {};
        });
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('button', { name: /Customers/ }));
        await u.click(screen.getByRole('button', { name: 'Delete folder Customers' }));
        await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete folder' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Folder not found');
        expect(screen.getByRole('button', { name: 'Delete folder Customers' })).toBeInTheDocument();
        expect(api.listDocumentsPage).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: 'f1' }));
    });
});

describe('DocumentsPage: the intro names what this reader can make', () => {
    it('without notebooks and spreadsheets', async () => {
        renderPage();
        expect(await screen.findByText('Make pages, customer documents and presentations here, on your own or together.')).toBeInTheDocument();
    });

    it('with notebooks and spreadsheets', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('a')], total: 1, people: {}, notebooks: true, spreadsheets: true });
        renderPage();
        expect(await screen.findByText('Make pages, notebooks, spreadsheets, customer documents and presentations here, on your own or together.')).toBeInTheDocument();
    });

    it('calls the designed type "Customer documents" in the type filter', async () => {
        renderPage();
        await screen.findByTestId('library-row-a');
        expect(within(screen.getByTestId('documents-format-filter')).getByRole('button', { name: /Customer documents/ })).toBeInTheDocument();
    });
});

describe('DocumentsPage: own templates in the gallery', () => {
    it('offers them, and choosing one copies it into a new document in the open folder', async () => {
        api.updateDocument.mockResolvedValue({});
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-a');
        await u.click(screen.getByRole('button', { name: /Customers/ }));
        await u.click(screen.getByTestId('documents-new'));
        await u.click(await screen.findByTestId('documents-new-template-tpl-1'));
        await waitFor(() => expect(api.documentRequest).toHaveBeenCalledWith('/tpl-1/duplicate', { kind: 'document', name: 'Welcome letter' }));
        expect(api.createDocument).not.toHaveBeenCalled();
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('from-tpl', { folderId: 'f1' }));
        expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor from-tpl');
    });

    it('offers only what can be a template in the Templates view, and no own templates there', async () => {
        renderPage();
        const u = userEvent.setup();
        await screen.findByTestId('library-row-a');
        await u.click(within(screen.getByTestId('documents-view')).getByRole('button', { name: /Templates/ }));
        await u.click(screen.getByTestId('documents-new'));
        const gallery = await screen.findByTestId('document-gallery');
        expect(within(gallery).getByText('Pages, notebooks and spreadsheets are made in Documents.')).toBeInTheDocument();
        expect(within(gallery).queryByTestId('documents-new-page')).not.toBeInTheDocument();
        expect(within(gallery).queryByTestId('documents-new-template-tpl-1')).not.toBeInTheDocument();
        expect(within(gallery).getByTestId('documents-new-presentation')).toBeInTheDocument();
    });
});

describe('DocumentsPage: sharing as the row says it', () => {
    it('says Shared, not Team, and the filter offers Private and Shared', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('s', { visibility: 'team' }), row('p', { visibility: 'private' })], total: 2, people: {} });
        renderPage();
        expect(await screen.findByTestId('library-row-s')).toHaveTextContent('· Shared');
        expect(screen.getByTestId('library-row-s')).not.toHaveTextContent('Team');
        expect(screen.getByTestId('library-row-p')).not.toHaveTextContent('Shared');
        const filter = screen.getByRole('combobox', { name: 'Visibility' });
        expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual(['Private and shared', 'Private', 'Shared']);
        expect(within(filter).getByRole('option', { name: 'Shared' })).toHaveValue('team');
    });
});

describe('DocumentsPage: categories on several at once', () => {
    it('adds categories to what each row already has', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('a', { categories: ['Legal'] }), row('c')], total: 2, people: {} });
        api.updateDocument.mockResolvedValue({});
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('checkbox', { name: 'Select Doc a' }));
        await u.click(screen.getByRole('checkbox', { name: 'Select Doc c' }));
        await u.type(screen.getByRole('textbox', { name: 'Categories' }), 'Sales, Q3');
        await u.click(screen.getByRole('button', { name: 'Add categories' }));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('a', { categories: ['Legal', 'Sales', 'Q3'] }));
        expect(api.updateDocument).toHaveBeenCalledWith('c', { categories: ['Sales', 'Q3'] });
    });

    it('does not add an empty list', async () => {
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('checkbox', { name: 'Select Doc a' }));
        expect(screen.getByRole('button', { name: 'Add categories' })).toBeDisabled();
    });

    it('clears categories only after a confirmation', async () => {
        api.listDocumentsPage.mockResolvedValue({ documents: [row('a', { categories: ['Legal'] })], total: 1, people: {} });
        api.updateDocument.mockResolvedValue({});
        renderPage();
        const u = userEvent.setup();
        await u.click(await screen.findByRole('checkbox', { name: 'Select Doc a' }));
        await u.click(screen.getByRole('button', { name: 'Clear categories' }));
        const dialog = await screen.findByRole('dialog');
        expect(api.updateDocument).not.toHaveBeenCalled();
        await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(api.updateDocument).not.toHaveBeenCalled();
        await u.click(screen.getByRole('button', { name: 'Clear categories' }));
        await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear categories' }));
        await waitFor(() => expect(api.updateDocument).toHaveBeenCalledWith('a', { categories: [] }));
    });
});
