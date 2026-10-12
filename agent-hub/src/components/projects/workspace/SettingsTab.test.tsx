import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import SettingsTab from './SettingsTab';
import type { WorkspaceTabProps } from './types';
import {
    EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID, reply, VIEWER_ID,
} from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

function renderTab(role: WorkspaceTabProps['role'], userId: string, routes: Record<string, unknown> = {}, projectOver: Partial<ReturnType<typeof makeProject>> = {}) {
    const api = makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(),
        'PUT /api/projects/p1': (call: { body: unknown }) => ({ ...makeProject(), ...(call.body as object), version: 4 }),
        'DELETE /api/projects/p1': { success: true },
        'DELETE /api/projects/p1/members/s-viewer': { success: true },
        ...routes,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    const onDeleted = vi.fn();
    const onLeft = vi.fn();
    const props: WorkspaceTabProps = {
        projectId: 'p1', project: makeProject({ role, ...projectOver }), role, currentUser: { id: userId },
        sub: null, onOpenSub: vi.fn(), onNavigate: vi.fn(),
    };
    render(withQueryClient(<SettingsTab {...props} onDeleted={onDeleted} onLeft={onLeft} />));
    return { api, onDeleted, onLeft, user: userEvent.setup() };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('SettingsTab — saving', () => {
    it('saves the edited fields with the loaded version, trimmed', async () => {
        const { api, user } = renderTab('editor', EDITOR_ID);
        const name = screen.getByTestId('project-field-name');
        expect(screen.getByTestId('settings-save')).toBeDisabled();
        await user.clear(name);
        await user.type(name, '  Autumn launch  ');
        await user.clear(screen.getByTestId('project-field-instructions'));
        await user.type(screen.getByTestId('project-field-instructions'), 'Be concise.');
        await user.click(screen.getByRole('checkbox', { name: 'Remember useful facts from chats' }));
        await user.click(screen.getByTestId('settings-save'));

        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1')[0].body).toMatchObject({
            name: 'Autumn launch', customInstructions: 'Be concise.', extractMemories: true, version: 3,
        });
        expect(await screen.findByText('Saved')).toBeInTheDocument();
        expect(screen.getByTestId('project-field-name')).toHaveValue('Autumn launch');
    });

    it('refuses an empty name before asking the server', async () => {
        const { api, user } = renderTab('owner', OWNER_ID);
        await user.clear(screen.getByTestId('project-field-name'));
        await user.click(screen.getByTestId('settings-save'));
        expect(await screen.findByText('Give the project a name.')).toBeInTheDocument();
        expect(api.callsTo('PUT', '/api/projects/p1')).toHaveLength(0);
    });

    it('on a 409 shows their version, and puts my edits back on top of it on request', async () => {
        const current = makeProject({ name: 'Their name', version: 7, role: undefined });
        const { api, user } = renderTab('editor', EDITOR_ID, {
            'PUT /api/projects/p1': (call: { body: { version?: number } }) => (call.body.version === 7
                ? { ...current, name: 'Mine', version: 8 }
                : reply(409, { error: 'This project was changed by someone else while you were editing.', current })),
        });
        const name = screen.getByTestId('project-field-name');
        await user.clear(name);
        await user.type(name, 'Mine');
        await user.click(screen.getByTestId('settings-save'));

        expect(await screen.findByTestId('settings-conflict')).toBeInTheDocument();
        expect(screen.getByTestId('project-field-name')).toHaveValue('Their name');
        await user.click(within(screen.getByTestId('settings-conflict')).getByRole('button', { name: 'Put my edits back' }));
        expect(screen.getByTestId('project-field-name')).toHaveValue('Mine');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1')).toHaveLength(2));
        expect(api.callsTo('PUT', '/api/projects/p1')[1].body).toMatchObject({ name: 'Mine', version: 7 });
    });

    it('is read-only for a viewer: disabled fields, no save', async () => {
        renderTab('viewer', VIEWER_ID);
        expect(screen.getByTestId('settings-readonly')).toBeInTheDocument();
        expect(screen.getByTestId('project-field-name')).toBeDisabled();
        expect(screen.getByTestId('project-field-instructions')).toBeDisabled();
        expect(screen.queryByTestId('settings-save')).toBeNull();
        expect(screen.queryByTestId('danger-zone')).toBeNull();
    });
});

describe('SettingsTab — delete and leave', () => {
    it('lets the owner delete after typing the name, then tells the host', async () => {
        const { api, onDeleted, user } = renderTab('owner', OWNER_ID);
        await user.click(screen.getByRole('button', { name: 'Delete this project' }));
        await user.type(screen.getByRole('textbox', { name: 'Type the name to confirm.' }), 'Launch plan');
        await user.click(screen.getByRole('button', { name: 'Delete for good' }));
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('p1'));
        expect(api.callsTo('DELETE', '/api/projects/p1')).toHaveLength(1);
    });

    it('shows a refused delete and keeps the project', async () => {
        const { onDeleted, user } = renderTab('owner', OWNER_ID, {
            'DELETE /api/projects/p1': reply(409, {
                error: 'Stop sharing the 2 shared chats first.', code: 'SHARED_CHATS_REMAIN', details: { sharedChats: 2 },
            }),
        });
        await user.click(screen.getByRole('button', { name: 'Delete this project' }));
        await user.type(screen.getByRole('textbox', { name: 'Type the name to confirm.' }), 'Launch plan');
        await user.click(screen.getByRole('button', { name: 'Delete for good' }));
        // Said from the code and its count in the reader's language; the
        // server's English sentence is only the fallback for unknown codes.
        expect(await screen.findByText(/^2 chats are still shared with this project/)).toBeInTheDocument();
        expect(screen.queryByText('Stop sharing the 2 shared chats first.')).not.toBeInTheDocument();
        expect(onDeleted).not.toHaveBeenCalled();
    });

    it('lets a member leave (their own share), not delete', async () => {
        const { api, onLeft, user } = renderTab('viewer', VIEWER_ID);
        expect(screen.queryByRole('button', { name: 'Delete this project' })).toBeNull();
        const leave = await screen.findByTestId('settings-leave-button');
        await waitFor(() => expect(leave).toBeEnabled());
        await user.click(leave);
        await user.click(within(await screen.findByRole('dialog', { name: 'Leave this project?' })).getByRole('button', { name: 'Leave' }));
        await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
        expect(api.callsTo('DELETE', '/api/projects/p1/members/s-viewer')).toHaveLength(1);
    });

    it('explains that a member through a group cannot leave on their own', async () => {
        renderTab('viewer', 'someone-in-marketing');
        expect(await screen.findByText(/You are in this project through a group/)).toBeInTheDocument();
    });
});

describe('SettingsTab — collaboration, ownership, archive', () => {
    it('lets the owner switch off "Editors may invite people" and saves it', async () => {
        const { api, user } = renderTab('owner', OWNER_ID, {}, { editorsCanInvite: true });
        await user.click(screen.getByRole('checkbox', { name: 'Editors may invite people' }));
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1')[0].body).toMatchObject({ editorsCanInvite: false });
    });

    it('never sends editorsCanInvite for an editor, and shows none of the owner cards', async () => {
        const { api, user } = renderTab('editor', EDITOR_ID, {}, { editorsCanInvite: true });
        expect(screen.queryByTestId('settings-ownership')).toBeNull();
        expect(screen.queryByTestId('settings-archive')).toBeNull();
        await user.type(screen.getByTestId('project-field-name'), '!');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1')).toHaveLength(1));
        expect(api.callsTo('PUT', '/api/projects/p1')[0].body).not.toHaveProperty('editorsCanInvite');
    });

    it('opens the transfer dialog from the Ownership card', async () => {
        const { user } = renderTab('owner', OWNER_ID);
        await user.click(screen.getByTestId('settings-transfer-open'));
        expect(await screen.findByTestId('transfer-dialog')).toBeInTheDocument();
    });

    it('archives after a confirmation', async () => {
        const { api, user } = renderTab('owner', OWNER_ID, { 'POST /api/projects/p1/archive': { success: true, archivedAt: '2026-10-10T10:00:00Z' } });
        await user.click(screen.getByTestId('settings-archive-open'));
        await user.click(within(await screen.findByRole('dialog', { name: 'Archive this project?' })).getByRole('button', { name: 'Archive' }));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/archive')).toHaveLength(1));
    });

    it('offers Restore instead for an archived project, and locks the form', async () => {
        const { api, user } = renderTab('owner', OWNER_ID, { 'POST /api/projects/p1/restore': { success: true, archivedAt: null } },
            { archivedAt: '2026-10-01T10:00:00Z' });
        expect(screen.queryByTestId('settings-archive-open')).toBeNull();
        await user.click(screen.getByTestId('settings-restore'));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/restore')).toHaveLength(1));
    });
});

describe('SettingsTab: mute this project', () => {
    it('lets any member mute and unmute it for themselves, even a viewer', async () => {
        const { api, user } = renderTab('viewer', VIEWER_ID, {
            'PUT /api/projects/p1/mute': { muted: true },
            'DELETE /api/projects/p1/mute': { muted: false },
        });
        const toggle = screen.getByRole('checkbox', { name: 'Mute this project for me' });
        expect(toggle).not.toBeChecked();
        await user.click(toggle);
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/mute')).toHaveLength(1));
    });

    it('unmutes from the state the project row carries (after a reload)', async () => {
        const { api, user } = renderTab('viewer', VIEWER_ID, { 'DELETE /api/projects/p1/mute': { muted: false } }, { muted: true });
        await user.click(screen.getByRole('checkbox', { name: 'Mute this project for me' }));
        await waitFor(() => expect(api.callsTo('DELETE', '/api/projects/p1/mute')).toHaveLength(1));
    });

    it('starts muted when the project row says so', () => {
        renderTab('editor', EDITOR_ID, {}, { muted: true });
        expect(screen.getByRole('checkbox', { name: 'Mute this project for me' })).toBeChecked();
    });
});
