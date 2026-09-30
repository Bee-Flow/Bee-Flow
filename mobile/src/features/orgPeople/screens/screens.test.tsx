/**
 * Every people screen against canned server answers: what it loads, the exact
 * body each write sends, and who is turned away. One file, so the mocks and
 * fixtures are written once.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { pressBack, type HeldLeave } from '@/shared/testing/screenMocks';
import { ToastProvider } from '@/shared/ui';

import { AccessScreen } from './AccessScreen';
import { CapabilityScreen } from './CapabilityScreen';
import { GroupScreen } from './GroupScreen';
import { GroupsScreen } from './GroupsScreen';
import { InvitationsScreen } from './InvitationsScreen';
import { MemberScreen } from './MemberScreen';
import { ModelTiersScreen } from './ModelTiersScreen';
import { OrgMembersScreen } from './OrgMembersScreen';
import { PeopleScreen } from './PeopleScreen';
import { RoleScreen } from './RoleScreen';
import { RolesScreen } from './RolesScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockAccess = { isOrgAdmin: true, perms: [] as string[], ncOrg: null as unknown };

const mockLeave: HeldLeave = { listener: null, dispatch: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: jest.requireActual('@/shared/testing/screenMocks').leaveNavigation(() => mockLeave),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => {
    const user = () => ({ id: 'me', organizationId: 'o1', ncOrg: mockAccess.ncOrg });
    return { useAuth: () => ({ user: user() }), useCurrentUser: user };
});
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => ({ isOrgAdmin: mockAccess.isOrgAdmin, mode: 'cloud' }),
    useHasPermission: (id: string) => mockAccess.perms.includes(id),
}));
// The markdown renderer ships as ESM; the org feature's index reaches it.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const ANSWERS: Record<string, unknown> = {
    '/auth/users': [
        { id: 'me', displayName: 'Me Admin', email: 'me@x.nl', orgRole: 'org_admin', groups: ['g1'] },
        { id: 'u2', displayName: 'Bea', email: 'bea@x.nl', orgRole: 'member', groups: [], mfaEnabled: true },
        { id: 'u3', displayName: 'Piet', email: 'piet@x.nl', status: 'pending', groups: [] },
        { id: 'admin', displayName: 'Administrator (System)', isSystem: true },
    ],
    '/auth/groups': [{ id: 'g1', name: 'Sales', description: 'Sellers', organizationId: 'o1', allowedTiers: [] }],
    '/auth/org-roles': {
        roles: [
            { id: 'member', permissions: ['member', 'use_apps'] },
            { id: 'org_admin', permissions: ['org_admin', 'manage_users', 'use_notebooks'] },
        ],
        editablePermissions: ['use_notebooks', 'use_apps'],
    },
    '/auth/invitations': [{ id: 5, email: 'new@x.nl', role: 'user', status: 'pending', inviterName: 'Me Admin' }],
    '/auth/organizations/o1': { id: 'o1', name: 'Acme', authMethod: 'google', autoApproveSSO: false },
    '/ai/config/custom-tiers-list': { tiers: [{ id: 'custom:sales', label: 'Sales tier' }] },
    '/ai/config/org-custom-chat-models': {
        orgTiers: [{ id: 'custom:sales', label: 'Sales tier', icon: '💼', modelId: 'gpt', allowedTaskTypes: ['direct_chat'] }],
        globalTiers: [{ id: 'custom:global', label: 'Global tier' }],
    },
    '/ai/providers': { providers: [{ id: 'p1', name: 'OpenAI' }] },
    '/ai/providers/p1/models': { models: [{ id: 'gpt', name: 'GPT' }] },
    '/auth/organizations/o1/group-access': {
        orgId: 'o1',
        mode: 'cloud',
        capabilities: [
            { id: 'notes', kind: 'core', name: 'Notes' },
            { id: 'slack', kind: 'integration', name: 'Slack' },
            { id: 'jira', kind: 'integration', name: 'Jira' },
        ],
        ceiling: ['notes', 'slack'],
        everyone: ['slack'],
        groups: [{ id: 'g1', name: 'Sales', granted: [] }],
        betaGoverned: true,
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockAccess, { isOrgAdmin: true, perms: [], ncOrg: null });
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    for (const verb of ['post', 'put', 'delete'] as const) {
        (api[verb] as jest.Mock).mockResolvedValue({ success: true });
    }
});

const renderScreen = (ui: ReactElement) =>
    renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
    );

const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));
/** The confirm sheet's button: the last element with that label (the row that opened it may share it). */
const confirmWith = (label: string) => fireEvent.press(screen.getAllByLabelText(label).at(-1)!);

describe('PeopleScreen', () => {
    it('shows the hub with counts, the pending banner, and saves auto-approve', async () => {
        await renderScreen(<PeopleScreen />);
        expect(await screen.findByText('1 user(s) are waiting for approval and cannot use AI yet.')).toBeTruthy();
        expect(screen.getByTestId('people-groups')).toBeTruthy();
        expect(screen.getByText('Groups, their members, roles and model tiers')).toBeTruthy();
        await press('people-members');
        expect(mockRouter.push).toHaveBeenCalledWith('/org/members');
        await waitFor(() => expect(screen.getByTestId('auto-approve-sso')).toBeTruthy());
        await press('auto-approve-sso');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1', { autoApproveSSO: true }));
    });

    it('offers only the roster to someone who may manage users but is not an org admin', async () => {
        Object.assign(mockAccess, { isOrgAdmin: false, perms: ['manage_users'] });
        await renderScreen(<PeopleScreen />);
        expect(screen.getByTestId('people-members')).toBeTruthy();
        expect(screen.queryByTestId('people-groups')).toBeNull();
        expect(screen.queryByTestId('people-invitations')).toBeNull();
    });

    it('turns away everyone else', async () => {
        Object.assign(mockAccess, { isOrgAdmin: false });
        await renderScreen(<PeopleScreen />);
        expect(screen.getByText('Only organisation administrators can open this')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/auth/users', expect.anything());
    });
});

describe('OrgMembersScreen', () => {
    it('lists pending sign-ups first and approves with the web’s body', async () => {
        await renderScreen(<OrgMembersScreen />);
        expect(await screen.findByText('Piet')).toBeTruthy();
        expect(screen.queryByText('Administrator (System)')).toBeNull();
        await press('approve-u3');
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/users/u3', { status: 'active', orgRole: 'user' }),
        );
    });

    it('rejects a pending sign-up after a confirm', async () => {
        await renderScreen(<OrgMembersScreen />);
        await screen.findByText('Piet');
        await press('reject-u3');
        await confirmWith('Reject');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/users/u3'));
    });

    it('invites from the member list without leaving it', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ success: true, emailSent: false, inviteUrl: 'https://x/r/9' });
        await renderScreen(<OrgMembersScreen />);
        await screen.findByText('Bea');
        await press('members-invite');
        await fireEvent.changeText(screen.getByTestId('invite-email'), 'c@d.nl');
        await fireEvent.press(screen.getByText('Send invitation'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/invitations', { email: 'c@d.nl', role: 'user' }));
        expect(await screen.findByText('https://x/r/9')).toBeTruthy();
        expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('opens on one role’s holders', async () => {
        await renderScreen(<OrgMembersScreen initialRole="member" />);
        expect(await screen.findByText('Bea')).toBeTruthy();
        expect(screen.queryByText('Me Admin')).toBeNull();
    });

    it('opens on the pending filter and clears it', async () => {
        await renderScreen(<OrgMembersScreen initialStatus="pending" />);
        expect(await screen.findByText('Piet')).toBeTruthy();
        expect(screen.queryByText('Bea')).toBeNull();
        await fireEvent.press(screen.getByText('Clear'));
        expect(await screen.findByText('Bea')).toBeTruthy();
    });
});

describe('MemberScreen', () => {
    it('changes a member’s role and resets their two-factor authentication', async () => {
        await renderScreen(<MemberScreen id="u2" />);
        expect(await screen.findAllByText('bea@x.nl')).toBeTruthy();
        await press('member-role');
        await press('role-option-org_admin');
        expect(await screen.findByText('Make Bea Organisation Admin?')).toBeTruthy();
        expect(api.put).not.toHaveBeenCalled();
        await confirmWith('Change role');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/users/u2', { orgRole: 'org_admin' }));
        await press('member-reset-mfa');
        await confirmWith('Reset 2FA');
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/users/u2/mfa/reset'));
    });

    it('asks before you demote yourself, then re-sends with the opt-in', async () => {
        (api.put as jest.Mock).mockRejectedValueOnce(
            new ApiError('This would remove your own administrator rights', {
                status: 409,
                body: { code: 'confirm_self_demotion' },
            }),
        );
        await renderScreen(<MemberScreen id="me" />);
        await screen.findAllByText('me@x.nl');
        await press('member-role');
        await press('role-option-member');
        await confirmWith('Yes, step down');
        await waitFor(() =>
            expect(api.put).toHaveBeenLastCalledWith('/auth/users/me', { orgRole: 'member', confirmSelfDemotion: true }),
        );
    });

    it('names a member’s groups on the row, and says the admin view once', async () => {
        await renderScreen(<MemberScreen id="me" />);
        await screen.findAllByText('me@x.nl');
        expect(screen.getByText('Sales')).toBeTruthy();
        expect(screen.queryByText('Status')).toBeNull();
    });

    it('assigns a group and deletes the user, naming them', async () => {
        await renderScreen(<MemberScreen id="u2" />);
        await screen.findAllByText('bea@x.nl');
        expect(screen.getByText('None')).toBeTruthy();
        await press('member-groups');
        await press('toggle-g1');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/users/u2', { groups: ['g1'] }));
        expect(screen.getByText('Delete user')).toBeTruthy();
        await press('member-remove');
        expect(await screen.findByText('Delete Bea?')).toBeTruthy();
        await confirmWith('Delete');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/users/u2'));
        await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    });

    it('puts a pending sign-up’s Approve and Reject first', async () => {
        await renderScreen(<MemberScreen id="u3" />);
        await screen.findAllByText('piet@x.nl');
        expect(screen.queryByTestId('member-remove')).toBeNull();
        await press('member-reject');
        expect(await screen.findByText('Reject Piet?')).toBeTruthy();
        await confirmWith('Reject');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/users/u3'));
        await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    });

    it('offers the member-less groups sheet a way to make a group', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/auth/groups' ? [] : (ANSWERS[path] ?? null)),
        );
        await renderScreen(<MemberScreen id="u2" />);
        await screen.findAllByText('bea@x.nl');
        await press('member-groups');
        await fireEvent.press(screen.getByText('Create New Group'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/groups');
    });

    it('is read-only for someone who may only manage users', async () => {
        Object.assign(mockAccess, { isOrgAdmin: false, perms: ['manage_users'] });
        await renderScreen(<MemberScreen id="u2" />);
        expect(await screen.findByText('Only an organisation administrator can change a member’s role, groups or access.')).toBeTruthy();
        expect(screen.getByText('Status')).toBeTruthy();
        expect(screen.queryByTestId('member-remove')).toBeNull();
        expect(screen.queryByTestId('member-role')).toBeNull();
    });
});

describe('InvitationsScreen', () => {
    it('invites by e-mail with a role', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ success: true, emailSent: true, inviteUrl: 'https://x/r/1' });
        await renderScreen(<InvitationsScreen />);
        expect(await screen.findByText('new@x.nl')).toBeTruthy();
        await press('open-invite');
        await fireEvent.changeText(screen.getByTestId('invite-email'), ' a@b.nl ');
        await press('invite-role-member');
        await fireEvent.press(screen.getByText('Send invitation'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/invitations', { email: 'a@b.nl', role: 'member' }));
    });

    it('opens the invite sheet straight away from billing’s Add user', async () => {
        await renderScreen(<InvitationsScreen startInviting />);
        expect(await screen.findByTestId('invite-email')).toBeTruthy();
    });

    it('says the rate limit in the server’s words', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(
            new ApiError('Too many requests — limit is 20 per 3600s. Retry in ~60s.', { status: 429 }),
        );
        await renderScreen(<InvitationsScreen />);
        await screen.findByText('new@x.nl');
        await press('open-invite');
        await fireEvent.changeText(screen.getByTestId('invite-email'), 'a@b.nl');
        await fireEvent.press(screen.getByText('Send invitation'));
        expect(await screen.findByText('Too many requests — limit is 20 per 3600s. Retry in ~60s.')).toBeTruthy();
    });

    it('revokes an open invitation', async () => {
        await renderScreen(<InvitationsScreen />);
        await screen.findByText('new@x.nl');
        await press('revoke-5');
        await confirmWith('Revoke');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/invitations/5'));
    });

    it('is the org admin’s alone', async () => {
        Object.assign(mockAccess, { isOrgAdmin: false, perms: ['manage_users'] });
        await renderScreen(<InvitationsScreen />);
        expect(screen.getByText('Only organisation administrators can open this')).toBeTruthy();
    });
});

describe('GroupsScreen and GroupScreen', () => {
    it('lists groups with their member count and creates one', async () => {
        await renderScreen(<GroupsScreen />);
        expect(await screen.findByText('Sales')).toBeTruthy();
        expect(await screen.findByText('1 member')).toBeTruthy();
        await press('open-create-group');
        await fireEvent.changeText(screen.getByTestId('group-name'), ' Legal ');
        await fireEvent.press(screen.getByText('Create'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/auth/groups', { name: 'Legal', description: '', organizationId: 'o1' }),
        );
    });

    it('sets a group’s tiers and role, one key per PUT', async () => {
        await renderScreen(<GroupScreen id="g1" />);
        await screen.findByTestId('tier-fast');
        expect(screen.getByTestId('tier-custom:sales')).toBeTruthy();
        await press('tier-fast');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/groups/g1', { allowedTiers: ['fast'] }));
        await press('group-role-row');
        await press('group-role-member');
        expect(await screen.findByText('This changes the role of everyone in the group (1 member).')).toBeTruthy();
        expect(api.put).not.toHaveBeenCalledWith('/auth/groups/g1', { orgRole: 'member' });
        await confirmWith('Change role');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/groups/g1', { orgRole: 'member' }));
    });

    it('adds a member from the group’s side and deletes the group', async () => {
        await renderScreen(<GroupScreen id="g1" />);
        await screen.findByTestId('group-members-row');
        await press('group-members-row');
        expect(screen.getByText('Members (1)')).toBeTruthy();
        const names = screen.getAllByTestId(/^toggle-/).map((row) => row.props.testID as string);
        expect(names[0]).toBe('toggle-me');
        await press('toggle-u2');
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/groups/g1/members', { userId: 'u2' }));
        await press('toggle-me');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/groups/g1/members/me'));
        await press('group-delete');
        expect(await screen.findByText('Delete Sales?')).toBeTruthy();
        expect(screen.getByText('Members keep their accounts but lose whatever this group granted them.')).toBeTruthy();
        await confirmWith('Delete');
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/auth/groups/g1'));
    });

    it('turns away someone who is not an org admin', async () => {
        Object.assign(mockAccess, { isOrgAdmin: false, perms: ['manage_users'] });
        await renderScreen(<GroupsScreen />);
        expect(screen.getByText('Only organisation administrators can open this')).toBeTruthy();
    });
});

describe('RolesScreen and RoleScreen', () => {
    it('lists the roles in the web’s order', async () => {
        await renderScreen(<RolesScreen />);
        expect(await screen.findByText('Organisation Admin')).toBeTruthy();
        expect(screen.getByText('Give a member a role on their page, or give a whole group a role.')).toBeTruthy();
        await press('role-member');
        expect(mockRouter.push).toHaveBeenCalledWith('/org/roles/member');
    });

    it('counts a role’s members and lists them', async () => {
        await renderScreen(<RoleScreen id="member" />);
        expect(await screen.findByText('1 member')).toBeTruthy();
        await press('role-holders');
        expect(mockRouter.push).toHaveBeenCalledWith('/org/members?role=member');
    });

    it('saves the full editable choice for a role', async () => {
        (api.put as jest.Mock).mockResolvedValueOnce({ id: 'member', permissions: ['use_apps', 'use_notebooks'] });
        await renderScreen(<RoleScreen id="member" />);
        await screen.findByTestId('perm-use_notebooks');
        await press('perm-use_notebooks');
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/org-roles/member', { permissions: ['use_apps', 'use_notebooks'] }),
        );
    });

    it('asks before Back throws an unsaved choice away, and leaves on "Leave"', async () => {
        await renderScreen(<RoleScreen id="member" />);
        await screen.findByTestId('perm-use_notebooks');
        expect(mockLeave.listener).toBeNull();
        await press('perm-use_notebooks');
        const held = await pressBack(mockLeave);
        expect(held.preventDefault).toHaveBeenCalled();
        expect(await screen.findByText('Unsaved changes')).toBeTruthy();
        await fireEvent.press(screen.getByText('Leave'));
        expect(mockLeave.dispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
        expect(api.put).not.toHaveBeenCalled();
    });
});

describe('ModelTiersScreen', () => {
    it('lists org and global tiers and adds one by posting the whole list', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ success: true, warnings: [], tiers: [] });
        await renderScreen(<ModelTiersScreen />);
        expect(await screen.findByText('💼 Sales tier')).toBeTruthy();
        expect(screen.getByText('✨ Global tier')).toBeTruthy();
        await press('add-tier');
        await fireEvent.changeText(screen.getByTestId('tier-label'), 'Legal');
        await press('tier-save');
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        const [path, body] = (api.post as jest.Mock).mock.calls[0] as [string, { tiers: { id: string }[] }];
        expect(path).toBe('/ai/config/org-custom-chat-models');
        expect(body.tiers.map((x) => x.id)).toEqual(['custom:sales', 'custom:legal']);
    });
});

describe('AccessScreen and CapabilityScreen', () => {
    it('lists capabilities by kind, narrowed by ?kind=, with the ceiling a tab away', async () => {
        await renderScreen(<AccessScreen kind="integration" />);
        expect(await screen.findByText('Slack')).toBeTruthy();
        expect(screen.queryByText('Notes')).toBeNull();
        expect(screen.getByText('All members')).toBeTruthy();
        await fireEvent.press(screen.getByText('Plan ceiling'));
        expect(await screen.findByText('Notes')).toBeTruthy();
        expect(screen.queryByText('Jira')).toBeNull();
    });

    it('grants to everyone and to a group, sending each scope’s whole list', async () => {
        await renderScreen(<CapabilityScreen id="notes" />);
        await screen.findByTestId('grant-everyone');
        await press('grant-group-g1');
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/groups/g1/access', { granted: ['notes'] }));
        await press('grant-everyone');
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1/org-access', { granted: ['slack', 'notes'] }),
        );
    });

    it('points at Groups when there is no group to grant to', async () => {
        const access = ANSWERS['/auth/organizations/o1/group-access'] as Record<string, unknown>;
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/auth/organizations/o1/group-access' ? { ...access, groups: [] } : (ANSWERS[path] ?? null)),
        );
        await renderScreen(<CapabilityScreen id="notes" />);
        await fireEvent.press(await screen.findByText('Create New Group'));
        expect(mockRouter.push).toHaveBeenCalledWith('/org/groups');
    });

    it('locks a capability outside the organisation’s access', async () => {
        await renderScreen(<CapabilityScreen id="jira" />);
        await screen.findByTestId('grant-everyone');
        await press('grant-everyone');
        expect(api.put).not.toHaveBeenCalled();
    });
});
