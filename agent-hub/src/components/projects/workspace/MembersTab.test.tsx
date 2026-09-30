import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import MembersTab from './MembersTab';
import type { WorkspaceTabProps } from './types';
import { EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

function renderTab(role: WorkspaceTabProps['role'], userId: string, extra: Partial<WorkspaceTabProps> = {}) {
    fetchMock.mockImplementation(makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(),
        'GET /auth/users': [{ id: 'u-new', displayName: 'Nina Newcomer' }],
        'GET /auth/groups': [],
    }).fetchImpl);
    const props: WorkspaceTabProps = {
        projectId: 'p1', project: makeProject({ role }), role, currentUser: { id: userId },
        sub: null, onOpenSub: vi.fn(), onNavigate: vi.fn(), ...extra,
    };
    render(withQueryClient(<MembersTab {...props} />));
}

beforeEach(() => { fetchMock.mockReset(); });

describe('MembersTab', () => {
    it('counts the owner plus every share, and explains the roles', async () => {
        renderTab('viewer', EDITOR_ID);
        expect(await screen.findByText('4')).toBeInTheDocument();
        expect(screen.getByTestId('members-roles')).toHaveTextContent('Reads everything in the project, changes nothing.');
        expect(screen.queryByTestId('members-invite-open')).toBeNull();
    });

    it('moves the focus into the invite form from the header button (owner)', async () => {
        const user = userEvent.setup();
        renderTab('owner', OWNER_ID);
        const picker = await screen.findByTestId('member-invite-picker');
        expect(picker).not.toHaveFocus();
        await user.click(screen.getByTestId('members-invite-open'));
        expect(picker).toHaveFocus();
    });

    it('arrives with the invite form focused when a quick action asked for it', async () => {
        renderTab('owner', OWNER_ID, { intent: 'invite' });
        const picker = await screen.findByTestId('member-invite-picker');
        await waitFor(() => expect(picker).toHaveFocus());
    });
});
