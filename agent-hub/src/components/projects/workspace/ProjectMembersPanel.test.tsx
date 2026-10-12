import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import ProjectMembersPanel from './ProjectMembersPanel';
import { useUndoCapture } from './undoTestKit';
import {
    EDITOR_ID, GROUP_ID, makeFakeApi, makeMembers, OWNER_ID, reply, VIEWER_ID,
} from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const NEWCOMER_ID = '55555555-5555-4555-8555-555555555555';

function serve(extra: Record<string, unknown> = {}) {
    const api = makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(),
        'GET /api/projects/p1/principals': ({ query }: { query: URLSearchParams }) => {
            const q = (query.get('q') || '').toLowerCase();
            return {
                users: [
                    { id: OWNER_ID, name: 'Olivia Owner' },
                    { id: NEWCOMER_ID, name: 'Nina Newcomer' },
                ].filter((u) => u.name.toLowerCase().includes(q)),
                groups: [{ id: GROUP_ID, name: 'Marketing', memberCount: 4 }, { id: 'g-sales', name: 'Sales', memberCount: 7 }]
                    .filter((g) => g.name.toLowerCase().includes(q)),
            };
        },
        'POST /api/projects/p1/share': { shareId: 's-new', shares: [] },
        'PUT /api/projects/p1/members/s-viewer': { success: true },
        'DELETE /api/projects/p1/members/s-viewer': { success: true },
        'DELETE /api/projects/p1/members/s-editor': { success: true },
        ...extra,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    return api;
}

function renderPanel(role: 'owner' | 'editor' | 'viewer', currentUserId: string, onLeft = vi.fn()) {
    render(withQueryClient(<ProjectMembersPanel projectId="p1" role={role} currentUserId={currentUserId} onLeft={onLeft} />));
    return { onLeft };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('ProjectMembersPanel — the list', () => {
    it('names the owner, people and groups from the members answer', async () => {
        serve();
        renderPanel('viewer', VIEWER_ID);
        expect(await screen.findByText('Olivia Owner')).toBeInTheDocument();
        expect(screen.getByText('Eddie Editor')).toBeInTheDocument();
        expect(screen.getByText('Marketing')).toBeInTheDocument();
        expect(within(screen.getByTestId('member-row-s-viewer')).getByText('(you)')).toBeInTheDocument();
    });

    it('shows a person without a name as unnamed, never by an e-mail address', async () => {
        // The member list carries names only (any viewer may read it).
        serve({ 'GET /api/projects/p1/members': makeMembers({ people: { [OWNER_ID]: { name: 'Olivia Owner' }, [EDITOR_ID]: {} } }) });
        renderPanel('viewer', VIEWER_ID);
        const row = await screen.findByTestId('member-row-s-editor');
        expect(within(row).getByText('Unnamed person')).toBeInTheDocument();
        expect(screen.queryByText(/@/)).toBeNull();
    });

    it('shows a load failure as a failure, with a retry, not as an empty project', async () => {
        serve({ 'GET /api/projects/p1/members': reply(403, { error: 'Forbidden' }) });
        renderPanel('owner', OWNER_ID);
        expect(await screen.findByTestId('members-error')).toBeInTheDocument();
        expect(screen.queryByTestId('members-empty')).toBeNull();
    });

    it('gives a viewer and an editor no invite form and no role controls', async () => {
        serve();
        renderPanel('editor', EDITOR_ID);
        await screen.findByText('Olivia Owner');
        expect(screen.queryByTestId('member-invite')).toBeNull();
        expect(screen.queryByRole('combobox', { name: /Role for/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    });
});

describe('ProjectMembersPanel — owner actions', () => {
    const undo = useUndoCapture();
    it('changes a role with PUT', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Vera Viewer' }), 'editor');
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/members/s-viewer')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1/members/s-viewer')[0].body).toEqual({ role: 'editor' });
    });

    it('takes a member out of the list at once and removes them for real only when the Undo toast runs out', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.click(await screen.findByRole('button', { name: 'Remove Vera Viewer' }));
        expect(screen.queryByRole('button', { name: 'Remove Vera Viewer' })).not.toBeInTheDocument();
        expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(0);
        act(() => undo.last().onExpire());
        await waitFor(() => expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(1));
    });

    it('keeps the member on Undo and never calls the API', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.click(await screen.findByRole('button', { name: 'Remove Vera Viewer' }));
        act(() => undo.last().onUndo());
        expect(await screen.findByRole('button', { name: 'Remove Vera Viewer' })).toBeInTheDocument();
        expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(0);
    });

    it('shows a refused role change inline', async () => {
        serve({ 'PUT /api/projects/p1/members/s-viewer': reply(403, { error: 'Only the owner can change roles' }) });
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Vera Viewer' }), 'editor');
        expect(await screen.findByText('Only the owner can change roles')).toBeInTheDocument();
    });
});

describe('ProjectMembersPanel — invite', () => {
    it('lists people by name from the principals search, leaves out who is already in, and invites', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        const box = await screen.findByRole('combobox', { name: 'Search people and groups' });
        await user.type(box, 'n');
        expect(await screen.findByTestId('principal-min-chars')).toBeInTheDocument();
        await user.type(box, 'i');
        expect(await screen.findByRole('button', { name: /Nina Newcomer/ })).toBeInTheDocument();
        expect(api.callsTo('GET', '/api/projects/p1/principals')[0].query.get('q')).toBe('ni');
        await user.clear(box);
        await user.type(box, 'ol');
        // Olivia is the owner: the server may list her, the picker does not offer her.
        await waitFor(() => expect(api.callsTo('GET', '/api/projects/p1/principals').length).toBeGreaterThan(1));
        expect(within(screen.getByRole('listbox')).queryByText('Olivia Owner')).toBeNull();
        await user.clear(box);
        await user.type(box, 'nina');
        await user.click(await screen.findByRole('button', { name: /Nina Newcomer/ }));
        await user.selectOptions(screen.getByTestId('member-invite-role'), 'editor');
        await user.click(screen.getByTestId('member-invite-submit'));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/share')).toHaveLength(1));
        expect(api.callsTo('POST', '/api/projects/p1/share')[0].body).toEqual({
            sharedWithType: 'user', sharedWithId: NEWCOMER_ID, permission: 'editor',
        });
    });

    it('says to ask the owner when the principals search is refused (403), with no id field', async () => {
        serve({ 'GET /api/projects/p1/principals': reply(403, { error: 'Forbidden' }) });
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.type(await screen.findByRole('combobox', { name: 'Search people and groups' }), 'ni');
        expect(await screen.findByTestId('member-invite-owner-only')).toHaveTextContent('Ask the owner to invite people.');
        expect(screen.queryByTestId('member-invite-id')).toBeNull();
    });

    it('invites a group (chip with its size) and shows the server’s refusal inline', async () => {
        serve({ 'POST /api/projects/p1/share': reply(400, { error: 'That person is not in your organisation' }) });
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.type(await screen.findByRole('combobox', { name: 'Search people and groups' }), 'sa');
        const hit = await screen.findByRole('button', { name: /Sales/ });
        expect(hit).toHaveTextContent('group · 7 people');
        await user.click(hit);
        await user.click(screen.getByTestId('member-invite-submit'));
        expect(await screen.findByText('That person is not in your organisation')).toBeInTheDocument();
    });

    it('shows an editor the form only when canInvite is given', async () => {
        serve();
        const { rerender } = render(withQueryClient(<ProjectMembersPanel projectId="p1" role="editor" currentUserId={EDITOR_ID} />));
        await screen.findByText('Olivia Owner');
        expect(screen.queryByTestId('member-invite')).toBeNull();
        rerender(withQueryClient(<ProjectMembersPanel projectId="p1" role="editor" currentUserId={EDITOR_ID} canInvite />));
        expect(await screen.findByTestId('member-invite')).toBeInTheDocument();
    });
});

describe('ProjectMembersPanel — leaving', () => {
    it('lets a member leave after confirming, then tells the host', async () => {
        const api = serve();
        const user = userEvent.setup();
        const { onLeft } = renderPanel('editor', EDITOR_ID);
        await user.click(await screen.findByTestId('member-leave'));
        await user.click(within(await screen.findByRole('dialog', { name: 'Leave this project?' })).getByRole('button', { name: 'Leave' }));
        await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
        expect(api.callsTo('DELETE', '/api/projects/p1/members/s-editor')).toHaveLength(1);
    });

    it('offers no leave button on somebody else’s row', async () => {
        serve();
        renderPanel('viewer', VIEWER_ID);
        await screen.findByText('Eddie Editor');
        expect(within(screen.getByTestId('member-row-s-editor')).queryByTestId('member-leave')).toBeNull();
        expect(within(screen.getByTestId('member-row-s-viewer')).getByTestId('member-leave')).toBeInTheDocument();
    });
});
