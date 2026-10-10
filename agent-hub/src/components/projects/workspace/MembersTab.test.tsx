import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import MembersTab from './MembersTab';
import type { WorkspaceTabProps } from './types';
import { EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID, VIEWER_ID } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

function renderTab(role: WorkspaceTabProps['role'], userId: string, extra: Partial<WorkspaceTabProps> = {}, directory: { members?: Parameters<typeof makeMembers>[0] } = {}) {
    fetchMock.mockImplementation(makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(directory.members),
        'GET /api/projects/p1/principals': { users: [{ id: 'u-new', name: 'Nina Newcomer' }], groups: [] },
    }).fetchImpl);
    const props: WorkspaceTabProps = {
        projectId: 'p1', project: makeProject({ role }), role, currentUser: { id: userId },
        sub: null, onOpenSub: vi.fn(), onNavigate: vi.fn(), ...extra,
    };
    render(withQueryClient(<MembersTab {...props} />));
}

beforeEach(() => { fetchMock.mockReset(); });

describe('MembersTab', () => {
    it('distinguishes people and group grants, and explains the roles', async () => {
        renderTab('viewer', EDITOR_ID);
        expect(await screen.findByText('3 people · 1 groups')).toBeInTheDocument();
        expect(screen.getByTestId('members-roles')).toHaveTextContent('Reads everything in the project, changes nothing.');
        expect(screen.queryByTestId('members-invite-open')).toBeNull();
    });

    it('moves the focus into the invite form from the header button (owner)', async () => {
        const user = userEvent.setup();
        renderTab('owner', OWNER_ID);
        const box = await screen.findByRole('combobox', { name: 'Search people and groups' });
        expect(box).not.toHaveFocus();
        await user.click(screen.getByTestId('members-invite-open'));
        expect(box).toHaveFocus();
    });

    it('arrives with the invite form focused when a quick action asked for it', async () => {
        renderTab('owner', OWNER_ID, { intent: 'invite' });
        const box = await screen.findByRole('combobox', { name: 'Search people and groups' });
        await waitFor(() => expect(box).toHaveFocus());
    });

    it('shows an editor the invite form only while the project lets editors invite', async () => {
        renderTab('editor', EDITOR_ID, { project: makeProject({ role: 'editor', editorsCanInvite: false }) });
        await screen.findByText('3 people · 1 groups');
        expect(screen.queryByTestId('member-invite')).toBeNull();
        expect(screen.queryByTestId('members-invite-open')).toBeNull();
    });

    it('shows an editor the invite form when editorsCanInvite is on', async () => {
        renderTab('editor', EDITOR_ID, { project: makeProject({ role: 'editor', editorsCanInvite: true }) });
        expect(await screen.findByTestId('member-invite')).toBeInTheDocument();
    });

    it('offers an organisation admin who is not the owner the transfer dialog', async () => {
        const user = userEvent.setup();
        renderTab('viewer', VIEWER_ID, { currentUser: { id: VIEWER_ID, isOrgAdmin: true } });
        await user.click(await screen.findByTestId('members-admin-transfer-open'));
        expect(await screen.findByTestId('transfer-dialog')).toBeInTheDocument();
        // An admin leaves the owner no seat: the stay-as choice is not offered.
        expect(screen.queryByRole('radio', { name: 'Stay as editor' })).toBeNull();
    });

    it('shows nobody else the admin line', async () => {
        renderTab('viewer', VIEWER_ID);
        await screen.findByText('3 people · 1 groups');
        expect(screen.queryByTestId('members-admin-transfer')).toBeNull();
    });

    it('disables role changes and removals while the project is archived', async () => {
        renderTab('owner', OWNER_ID, { readOnly: true });
        await screen.findByText('3 people · 1 groups');
        const selects = screen.getAllByRole('combobox', { name: /^Role for / });
        expect(selects.length).toBeGreaterThan(0);
        for (const select of selects) {
            expect(select).toBeDisabled();
            expect(select).toHaveAttribute('title', 'This project is archived and read-only. Restore it to change anything.');
        }
        for (const button of screen.getAllByRole('button', { name: /^Remove / })) expect(button).toBeDisabled();
    });
});
