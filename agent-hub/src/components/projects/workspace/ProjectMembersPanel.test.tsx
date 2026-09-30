import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import ProjectMembersPanel from './ProjectMembersPanel';
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
        'GET /auth/users': [
            { id: OWNER_ID, displayName: 'Olivia Owner' },
            { id: NEWCOMER_ID, displayName: 'Nina Newcomer', email: 'nina@example.org' },
            { id: 'admin', displayName: 'Administrator (System)', isSystem: true },
        ],
        'GET /auth/groups': [{ id: GROUP_ID, name: 'Marketing' }, { id: 'g-sales', name: 'Sales' }],
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
    it('changes a role with PUT and removes a member only after confirming', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for Vera Viewer' }), 'editor');
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/members/s-viewer')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1/members/s-viewer')[0].body).toEqual({ role: 'editor' });

        await user.click(screen.getByRole('button', { name: 'Remove Vera Viewer' }));
        const dialog = await screen.findByRole('dialog', { name: 'Remove Vera Viewer?' });
        expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(0);
        await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(1));
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
    it('invites a person picked from the directory, leaving out who is already in', async () => {
        const api = serve();
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        const picker = await screen.findByTestId('member-invite-picker');
        await waitFor(() => expect(within(picker).getByRole('option', { name: /Nina Newcomer/ })).toBeInTheDocument());
        expect(within(picker).queryByRole('option', { name: /Olivia Owner/ })).toBeNull();
        expect(within(picker).queryByRole('option', { name: /Administrator/ })).toBeNull();

        await user.selectOptions(picker, NEWCOMER_ID);
        await user.selectOptions(screen.getByTestId('member-invite-role'), 'editor');
        await user.click(screen.getByTestId('member-invite-submit'));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/share')).toHaveLength(1));
        expect(api.callsTo('POST', '/api/projects/p1/share')[0].body).toEqual({
            sharedWithType: 'user', sharedWithId: NEWCOMER_ID, permission: 'editor',
        });
    });

    it('falls back to an id field when the directory is closed (403), and checks the id', async () => {
        const api = serve({ 'GET /auth/users': reply(403, { error: 'Permission required' }) });
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        const field = await screen.findByTestId('member-invite-id');
        await user.type(field, 'not-an-id');
        await user.click(screen.getByTestId('member-invite-submit'));
        expect(await screen.findByText('That is not a valid id.')).toBeInTheDocument();
        expect(api.callsTo('POST', '/api/projects/p1/share')).toHaveLength(0);

        await user.clear(field);
        await user.type(field, NEWCOMER_ID);
        await user.click(screen.getByTestId('member-invite-submit'));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/share')).toHaveLength(1));
        expect(api.callsTo('POST', '/api/projects/p1/share')[0].body).toMatchObject({ sharedWithType: 'user', permission: 'viewer' });
    });

    it('shows the server’s refusal of an invite inline', async () => {
        serve({ 'POST /api/projects/p1/share': reply(400, { error: 'That person is not in your organisation' }) });
        const user = userEvent.setup();
        renderPanel('owner', OWNER_ID);
        const groupRadio = await screen.findByRole('radio', { name: 'Group' });
        await user.click(groupRadio);
        const picker = await screen.findByTestId('member-invite-picker');
        await waitFor(() => expect(within(picker).getByRole('option', { name: 'Sales' })).toBeInTheDocument());
        expect(within(picker).queryByRole('option', { name: 'Marketing' })).toBeNull();
        await user.selectOptions(picker, 'g-sales');
        await user.click(screen.getByTestId('member-invite-submit'));
        expect(await screen.findByText('That person is not in your organisation')).toBeInTheDocument();
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
