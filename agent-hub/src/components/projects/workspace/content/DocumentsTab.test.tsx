import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, MEMBERS, OWNER_ID, pending, tabProps, type RouteAnswer } from './contentTestKit';
import type { ContentTabProps } from './types';

// Fresh spies per test (assigned in beforeEach) rather than reset ones: the
// module mock hands out this object, and the code reads its methods per call.
const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));
vi.mock('../../../../pages/documents/DocumentEditor', () => ({
    default: ({ documentId, onBack }: { documentId: string; onBack: () => void }) => (
        <div data-testid="document-editor">
            editing {documentId}
            <button type="button" onClick={onBack}>editor back</button>
        </div>
    ),
}));

// The starters come from the document service (authFetch), not apiClient.
vi.mock('../../../../pages/documents/documentQueries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../pages/documents/documentQueries')>()),
    useStarters: () => ({ data: [], isPending: false, isError: false }),
}));

import DocumentsTab from './DocumentsTab';

const DOCS = [
    { id: 'd-mine', name: 'Budget 2027', docType: 'document', userId: EDITOR_ID, updatedAt: '2026-09-20T10:00:00Z' },
    { id: 'd-theirs', name: 'Kick-off deck', docType: 'presentation', userId: OWNER_ID, updatedAt: '2026-09-21T10:00:00Z' },
];

function routes(documents: RouteAnswer, extra: Record<string, RouteAnswer> = {}) {
    return getRouter({
        '/api/projects/p1/resources': typeof documents === 'function' || documents instanceof Error ? documents : { role: 'editor', documents },
        '/api/projects/p1/members': MEMBERS,
        ...extra,
    });
}

function renderTab(role: ContentTabProps['role'], extra: Partial<ContentTabProps> = {}) {
    const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn() };
    render(withQueryClient(<DocumentsTab {...tabProps(role, handlers, extra)} />));
    return handlers;
}

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(routes(DOCS));
    client.put.mockImplementation(async () => ({ success: true }));
    client.post.mockImplementation(async () => ({ document: { id: 'd-new', name: 'Plan' } }));
});

describe('DocumentsTab: states', () => {
    it('shows skeleton rows while the project content loads', () => {
        client.get.mockImplementation(routes(() => pending()));
        renderTab('editor');
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('says the documents could not be loaded, and retries, instead of showing an empty project', async () => {
        const user = userEvent.setup();
        client.get.mockImplementation(routes(new Error('HTTP 500')));
        renderTab('editor');
        expect(await screen.findByText('The documents of this project could not be loaded.')).toBeInTheDocument();
        expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
        client.get.mockImplementation(routes(DOCS));
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Budget 2027')).toBeInTheDocument();
    });

    it('treats a section the server could not read (null) as an error, not as empty', async () => {
        client.get.mockImplementation(routes(null));
        renderTab('editor');
        expect(await screen.findByText('The documents of this project could not be loaded.')).toBeInTheDocument();
    });

    it('explains the feature with a create action when the project has no documents', async () => {
        client.get.mockImplementation(routes([]));
        renderTab('editor');
        expect(await screen.findByText('No documents yet')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'New document' }).length).toBeGreaterThan(0);
    });

    it('offers a viewer no create, add or remove controls', async () => {
        renderTab('viewer');
        expect(await screen.findByText('Budget 2027')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'New document' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add existing' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Remove .* from the project/ })).not.toBeInTheDocument();
        expect(screen.getByText(/Ask the owner for editor access/)).toBeInTheDocument();
    });
});

describe('DocumentsTab: list', () => {
    it('lists name, type and owner, and opens a document in place', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('editor');
        const row = await screen.findByTestId('project-document-d-theirs');
        expect(within(row).getByText('Presentation')).toBeInTheDocument();
        expect(within(row).getByText('Olivia Owner')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-document-d-mine')).getByText('You')).toBeInTheDocument();
        await user.click(within(row).getByText('Kick-off deck'));
        expect(onOpenSub).toHaveBeenCalledWith('d-theirs');
    });

    it('lets an editor remove only their own documents, and the owner any', async () => {
        renderTab('editor');
        await screen.findByText('Budget 2027');
        expect(screen.getByRole('button', { name: 'Remove Budget 2027 from the project' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove Kick-off deck from the project' })).not.toBeInTheDocument();
    });

    it('takes a document out after confirmation, without deleting it', async () => {
        const user = userEvent.setup();
        renderTab('owner');
        await user.click(await screen.findByRole('button', { name: 'Remove Kick-off deck from the project' }));
        expect(screen.getByText('Remove this document from the project?')).toBeInTheDocument();
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'document', id: 'd-theirs', attach: false }, { retry: false },
        ));
        expect(client.delete).not.toHaveBeenCalled();
    });

    it('filters the list by name', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await screen.findByText('Budget 2027');
        await user.type(screen.getByRole('searchbox', { name: 'Search documents' }), 'deck');
        expect(screen.queryByText('Budget 2027')).not.toBeInTheDocument();
        expect(screen.getByText('Kick-off deck')).toBeInTheDocument();
    });
});

describe('DocumentsTab: create failure and add', () => {
    it('keeps the gallery open with the server message when creating fails', async () => {
        const user = userEvent.setup();
        const { ApiError } = await import('../../../../api/client');
        client.post.mockImplementation(async () => { throw new ApiError('nope', { status: 403, body: { error: 'Editors only.' } }); });
        const { onOpenSub } = renderTab('editor');
        client.get.mockImplementation(routes(DOCS, { '/api/studio-documents': { documents: [], spreadsheets: false } }));
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByTestId('documents-new-page'));
        expect(await screen.findByText('Editors only.')).toBeInTheDocument();
        expect(onOpenSub).not.toHaveBeenCalled();
    });

    it('adds one of my own documents from the picker', async () => {
        const user = userEvent.setup();
        client.get.mockImplementation(routes(DOCS, {
            '/api/studio-documents': { documents: [
                { id: 'd-mine', name: 'Budget 2027', userId: EDITOR_ID },
                { id: 'd-other', name: 'Draft letter', docType: 'letter', userId: EDITOR_ID },
            ] },
        }));
        renderTab('editor', { intent: 'add' });
        const dialog = await screen.findByRole('dialog', { name: 'Add a document' });
        expect(await within(dialog).findByText('Draft letter')).toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'Add Budget 2027' })).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Add Draft letter' }));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'document', id: 'd-other', attach: true }, { retry: false },
        ));
    });
});

describe('DocumentsTab: new document gallery', () => {
    const TEMPLATES = { documents: [
        { id: 't-letter', name: 'Welcome letter', docType: 'letter' },
        { id: 't-sheet', name: 'Budget grid', docType: 'spreadsheet' },
    ], spreadsheets: true, notebooks: true };

    function withMine(answer: unknown = TEMPLATES) {
        client.get.mockImplementation(routes(DOCS, { '/api/studio-documents': answer }));
    }

    it('opens the same gallery as the Studio from New document', async () => {
        const user = userEvent.setup();
        withMine();
        renderTab('editor');
        await user.click(await screen.findByTestId('documents-new'));
        const gallery = await screen.findByTestId('document-gallery');
        expect(within(gallery).getByTestId('documents-new-page')).toBeInTheDocument();
        expect(within(gallery).getByTestId('documents-new-notebook')).toBeInTheDocument();
        expect(within(gallery).getByTestId('documents-new-presentation')).toBeInTheDocument();
        expect(await within(gallery).findByText('Your templates')).toBeInTheDocument();
        expect(within(gallery).getByText('Welcome letter')).toBeInTheDocument();
        expect(within(gallery).queryByText('Budget grid')).not.toBeInTheDocument();
    });

    it('creates a page: written together in real time', async () => {
        const user = userEvent.setup();
        withMine();
        const { onOpenSub } = renderTab('editor');
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByTestId('documents-new-page'));
        await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('d-new'));
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/documents', { name: 'Untitled page', docType: 'page' }, { retry: false });
    });

    it('creates a presentation and a spreadsheet when chosen', async () => {
        const user = userEvent.setup();
        withMine();
        const { onOpenSub } = renderTab('editor');
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByTestId('documents-new-presentation'));
        await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('d-new'));
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/documents', { name: 'Untitled presentation', docType: 'presentation' }, { retry: false });
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByTestId('documents-new-spreadsheet'));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/documents', { name: 'Untitled spreadsheet', docType: 'spreadsheet' }, { retry: false }));
    });

    it('copies one of my own templates', async () => {
        const user = userEvent.setup();
        withMine();
        const { onOpenSub } = renderTab('editor');
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByRole('button', { name: 'Welcome letter' }));
        await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('d-new'));
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/documents', { name: 'Welcome letter', templateId: 't-letter' }, { retry: false });
    });

    it('makes a project notebook and opens it in the notebooks tab', async () => {
        const user = userEvent.setup();
        withMine();
        client.post.mockImplementation(async () => ({ notebook: { id: 'nb-new', name: 'Untitled notebook' } }));
        const onOpenTab = vi.fn();
        const { onOpenSub } = renderTab('editor', { onOpenTab });
        await user.click(await screen.findByTestId('documents-new'));
        await user.click(await screen.findByTestId('documents-new-notebook'));
        await waitFor(() => expect(onOpenTab).toHaveBeenCalledWith('notebooks', 'nb-new'));
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/notebooks', { name: 'Untitled notebook' }, { retry: false });
        expect(onOpenSub).not.toHaveBeenCalled();
    });

    it('hides the spreadsheet when the reader may not make one', async () => {
        const user = userEvent.setup();
        withMine({ documents: [], spreadsheets: false, notebooks: true });
        renderTab('editor');
        await user.click(await screen.findByTestId('documents-new'));
        await screen.findByTestId('documents-new-page');
        expect(screen.queryByTestId('documents-new-spreadsheet')).not.toBeInTheDocument();
        expect(screen.queryByText('Your templates')).not.toBeInTheDocument();
    });

    it('opens the gallery straight away for the create intent', async () => {
        withMine();
        renderTab('editor', { intent: 'create' });
        expect(await screen.findByTestId('document-gallery')).toBeInTheDocument();
    });
});

describe('DocumentsTab: what changed', () => {
    it('marks a document somebody else changed since the reader last looked, and only that one', async () => {
        client.get.mockImplementation(routes(DOCS, {
            '/api/projects/p1/changes': { groups: [{
                item: { type: 'document', id: 'd-theirs', title: 'Kick-off deck', available: true }, unread: true,
                lastChangedAt: '2026-09-21T10:00:00Z', changeCount: 2, contributors: [{ userId: OWNER_ID, kind: 'user' }],
                stats: { wordsAdded: 12, wordsRemoved: 0, blocksChanged: 1 }, kinds: ['edited'],
            }] },
        }));
        client.post.mockImplementation(async (path: string) => (path.endsWith('/visit') ? { prevVisitAt: null } : { document: { id: 'd-new' } }));
        renderTab('editor');
        expect(await screen.findByTestId('project-document-unread-d-theirs')).toHaveTextContent('Changed since you last looked');
        expect(screen.queryByTestId('project-document-unread-d-mine')).not.toBeInTheDocument();
    });

    it('says nothing when the marks cannot be read', async () => {
        renderTab('editor');
        await screen.findByText('Kick-off deck');
        expect(screen.queryByTestId(/project-document-unread-/)).not.toBeInTheDocument();
    });
});

describe('DocumentsTab: one document', () => {
    it('opens the editor in place and goes back to the list', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('editor', { sub: 'd-mine' });
        expect(await screen.findByTestId('document-editor')).toHaveTextContent('editing d-mine');
        await user.click(screen.getByRole('button', { name: 'editor back' }));
        expect(onOpenSub).toHaveBeenCalledWith(null);
    });
});
