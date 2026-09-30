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

import NotebooksTab from './NotebooksTab';

const NOTEBOOKS = [
    { id: 'nb-1', name: 'Market research', preview: 'Competitor pricing notes', sourceCount: 3, userId: EDITOR_ID, updatedAt: '2026-09-20T10:00:00Z' },
    { id: 'nb-2', name: 'Interview notes', preview: '', sourceCount: 0, userId: OWNER_ID, updatedAt: '2026-09-21T10:00:00Z' },
];

function routes(notebooks: RouteAnswer, extra: Record<string, RouteAnswer> = {}) {
    return getRouter({
        '/api/projects/p1/resources': typeof notebooks === 'function' || notebooks instanceof Error ? notebooks : { role: 'editor', notebooks },
        '/api/projects/p1/members': MEMBERS,
        ...extra,
    });
}

function renderTab(role: ContentTabProps['role'], extra: Partial<ContentTabProps> = {}) {
    const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn() };
    render(withQueryClient(<NotebooksTab {...tabProps(role, handlers, extra)} />));
    return handlers;
}

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(routes(NOTEBOOKS));
    client.put.mockImplementation(async () => ({ success: true }));
    client.post.mockImplementation(async () => ({ notebook: { id: 'nb-new', name: 'Pricing' } }));
});

describe('NotebooksTab: states', () => {
    it('shows placeholder cards while loading', () => {
        client.get.mockImplementation(routes(() => pending()));
        renderTab('editor');
        expect(screen.getByTestId('project-notebooks-loading')).toBeInTheDocument();
    });

    it('keeps "could not load" apart from "no notebooks"', async () => {
        client.get.mockImplementation(routes(new Error('HTTP 503')));
        renderTab('editor');
        expect(await screen.findByText('The notebooks of this project could not be loaded.')).toBeInTheDocument();
        expect(screen.queryByText('No notebooks yet')).not.toBeInTheDocument();
    });

    it('explains notebooks and offers to create one when there are none', async () => {
        const user = userEvent.setup();
        client.get.mockImplementation(routes([]));
        renderTab('editor');
        expect(await screen.findByText('No notebooks yet')).toBeInTheDocument();
        const [, emptyAction] = screen.getAllByRole('button', { name: 'New notebook' });
        await user.click(emptyAction);
        expect(screen.getByRole('dialog', { name: 'New notebook' })).toBeInTheDocument();
    });

    it('gives a viewer the cards without any way to change the project', async () => {
        client.get.mockImplementation(routes([]));
        renderTab('viewer');
        expect(await screen.findByText('No notebooks yet')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'New notebook' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add existing' })).not.toBeInTheDocument();
    });
});

describe('NotebooksTab: cards', () => {
    it('shows each notebook with its preview and owner, and opens it in the notebook editor', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('editor');
        const card = await screen.findByTestId('project-notebook-nb-2');
        expect(within(card).getByText('Olivia Owner')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-notebook-nb-1')).getByText('Competitor pricing notes')).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Open notebook Interview notes' }));
        expect(onOpenSub).toHaveBeenCalledWith('nb-2');
    });

    it('offers removal of own notebooks to an editor and takes one out after confirmation', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await screen.findByTestId('project-notebook-nb-1');
        expect(screen.queryByRole('button', { name: 'Remove Interview notes from the project' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Remove Market research from the project' }));
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'notebook', id: 'nb-1', attach: false }, { retry: false },
        ));
    });

    it('does nothing when the removal is cancelled', async () => {
        const user = userEvent.setup();
        renderTab('owner');
        await user.click(await screen.findByRole('button', { name: 'Remove Interview notes from the project' }));
        await user.click(screen.getByTestId('confirm-dialog-cancel'));
        expect(client.put).not.toHaveBeenCalled();
    });
});

describe('NotebooksTab: create and add', () => {
    it('creates a notebook in the project, then opens it', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('editor', { intent: 'create' });
        const dialog = await screen.findByRole('dialog', { name: 'New notebook' });
        await user.type(within(dialog).getByLabelText('Name'), 'Pricing');
        await user.type(within(dialog).getByLabelText('Description (optional)'), 'What we charge');
        await user.click(screen.getByRole('button', { name: 'Create and open' }));
        await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('nb-new'));
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/notebooks', { name: 'Pricing', description: 'What we charge' }, { retry: false });
    });

    it('does not submit an empty name', async () => {
        const user = userEvent.setup();
        renderTab('editor', { intent: 'create' });
        await screen.findByRole('dialog', { name: 'New notebook' });
        expect(screen.getByRole('button', { name: 'Create and open' })).toBeDisabled();
        await user.type(screen.getByLabelText('Name'), '   ');
        expect(screen.getByRole('button', { name: 'Create and open' })).toBeDisabled();
    });

    it('shows the refusal on the row when adding an existing notebook fails', async () => {
        const user = userEvent.setup();
        const { ApiError } = await import('../../../../api/client');
        client.get.mockImplementation(routes(NOTEBOOKS, {
            '/api/notebooks': { notebooks: [{ id: 'nb-9', name: 'Old notes', projectId: 'p-other' }] },
        }));
        client.put.mockImplementation(async () => { throw new ApiError('HTTP 404', { status: 404, body: { error: 'Not found, or not yours to move' } }); });
        renderTab('editor');
        await user.click(await screen.findByTestId('notebooks-add-existing'));
        const dialog = await screen.findByRole('dialog', { name: 'Add a notebook' });
        expect(await within(dialog).findByText(/In another project, adding moves it here/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Add Old notes' }));
        expect(await within(dialog).findByText('Not found, or not yours to move')).toBeInTheDocument();
    });
});

describe('NotebooksTab: a reader who may not use notebooks', () => {
    it('lists the notebooks, says why they cannot be opened, and offers no way to make or add one', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderTab('editor', { notebooksEnabled: false, intent: 'create' });
        const card = await screen.findByTestId('project-notebook-nb-2');
        expect(screen.getByTestId('project-notebooks-unavailable')).toHaveTextContent('Notebooks are not available to you');
        expect(within(card).queryByRole('button', { name: /Open notebook/ })).toBeNull();
        await user.click(within(card).getByText('Interview notes'));
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'New notebook' })).toBeNull();
        expect(screen.queryByTestId('notebooks-add-existing')).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
        // The viewer note would contradict the reason above it.
        expect(screen.queryByText(/Ask the owner for editor access/)).toBeNull();
        expect(client.post).not.toHaveBeenCalledWith('/api/projects/p1/notebooks', expect.anything(), expect.anything());
    });

    it('an empty project offers no create either', async () => {
        client.get.mockImplementation(routes([]));
        renderTab('owner', { notebooksEnabled: false });
        expect(await screen.findByText('No notebooks yet')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'New notebook' })).toBeNull();
    });

    it('a create the server refuses with notebooks_unavailable is said in words, not as the server’s English', async () => {
        const user = userEvent.setup();
        const { ApiError } = await import('../../../../api/client');
        client.post.mockImplementation(async () => {
            throw new ApiError('HTTP 403', { status: 403, body: { error: 'Notebooks are not available to you, so no notebook was created.', code: 'notebooks_unavailable' } });
        });
        renderTab('editor', { intent: 'create' });
        const dialog = await screen.findByRole('dialog', { name: 'New notebook' });
        await user.type(within(dialog).getByLabelText('Name'), 'Pricing');
        await user.click(screen.getByRole('button', { name: 'Create and open' }));
        expect(await within(dialog).findByText(/your plan or your role does not include them/)).toBeInTheDocument();
    });
});
