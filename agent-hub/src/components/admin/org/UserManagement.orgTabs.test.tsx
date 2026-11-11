// What Settings > Organisation > Users & Groups offered an organisation admin, now on the Users screen of the
// admin dashboard: invitations, the organisation's roles, its model tiers, the Nextcloud sync view, letting
// pending accounts in, auto-approve, and a group's inherited role and allowed tiers.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UserManagement from './UserManagement';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { ORG_ROLES } from '@/config/orgRoles';
import { renderWithClient as render } from '@/test/render';

const orgAdmin = {
    id: 'me', permissions: ['manage_users'], isAdmin: false, role: 'user', orgRole: 'org_admin',
    organizationId: 'o1', organizations: ['o1'], homeOrganization: { id: 'o1', name: 'Org One' }, ncOrg: { instanceId: 'nc1' } as { instanceId: string } | null,
};
const platformAdmin = { ...orgAdmin, permissions: ['all'], isAdmin: true, role: 'admin', ncOrg: null };

const ORGS = [{ id: 'o1', name: 'Org One', authMethod: 'google', autoApproveSSO: false }, { id: 'o2', name: 'Org Two' }];
const MEMBERS = [
    { id: 'u1', username: 'jan', displayName: 'Jan', role: 'user', orgRole: 'member', organizationId: 'o1', groups: ['g1'] },
    { id: 'u2', username: 'pia', displayName: 'Pia', role: 'user', status: 'pending', organizationId: 'o1', groups: [] },
];
const GROUP = { id: 'g1', name: 'Finance', organizationId: 'o1', permissions: [], roles: [], allowedTiers: ['fast'], orgRole: '' };
const INVITATION = { id: 'i1', email: 'new@example.com', role: 'user', status: 'pending', inviterName: 'Me', expires_at: '2030-01-01T00:00:00Z' };

const ANSWERS: Record<string, unknown> = {
    '/auth/users': MEMBERS,
    '/auth/groups': [GROUP],
    '/auth/organizations': ORGS,
    '/auth/roles': [],
    '/auth/permissions': [],
    '/auth/invitations': [INVITATION],
    '/auth/org-roles': { roles: ORG_ROLES.map(r => ({ id: r.id, permissions: [] })), editablePermissions: [] },
    '/ai/config/org-custom-chat-models': { orgTiers: [], globalTiers: [] },
    '/ai/providers': { providers: [] },
    '/ai/config/custom-tiers-list': { tiers: [] },
};

let writes: Array<{ method: string; path: string; body: unknown }>;

beforeEach(() => {
    writes = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        const full = String(url).split('?')[0];
        // The API base may prefix the path; the table is keyed by the path itself.
        const path = Object.keys(ANSWERS).find(k => full.endsWith(k)) ?? full.slice(full.indexOf('/auth') >= 0 ? full.indexOf('/auth') : 0);
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
            writes.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
            return new Response('{"success":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify(ANSWERS[path] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

const choice = (orgId: string | null): AdminOrgChoice => ({
    isPlatformAdmin: true, orgId, orgName: null, organizations: [{ id: 'o1', name: 'Org One' }, { id: 'o2', name: 'Org Two' }],
    organizationsLoaded: true, pending: false, homeOrganization: { id: 'o1', name: 'Org One' }, setOrgId: () => {},
});

const open = (user: typeof orgAdmin, section: string, orgChoice?: AdminOrgChoice) => {
    const screenUnderTest = <UserManagement user={user} activeSection={section} />;
    return render(orgChoice ? <AdminOrgProvider value={orgChoice}>{screenUnderTest}</AdminOrgProvider> : screenUnderTest);
};

/** The marker each organisation-only tab shows when it works on the viewer's organisation. */
const TABS: Array<[string, RegExp]> = [
    ['invitations', /new@example\.com/],
    ['org-roles', /Organisation Roles/],
    ['custom-tiers', /Organisation Custom Tiers/],
];

describe('organisation-only tabs of the Users screen', () => {
    it.each(TABS)('%s: an organisation admin works on their own organisation', async (section, marker) => {
        open(orgAdmin, section);
        expect(await screen.findByText(marker)).toBeInTheDocument();
    });

    it.each(TABS)('%s: a platform admin with their own organisation chosen sees it', async (section, marker) => {
        open(platformAdmin, section, choice('o1'));
        expect(await screen.findByText(marker)).toBeInTheDocument();
    });

    it.each(TABS)('%s: a platform admin with "All organisations" is asked to choose one', async (section) => {
        open(platformAdmin, section, choice(null));
        expect(await screen.findByTestId('admin-choose-org')).toHaveTextContent('Choose an organisation above');
        expect(screen.queryByText('Organisation Custom Tiers')).not.toBeInTheDocument();
    });

    it.each(TABS)('%s: a platform admin who chose another organisation works on that one', async (section, marker) => {
        open(platformAdmin, section, choice('o2'));
        expect(await screen.findByText(marker)).toBeInTheDocument();
        const reads = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
        expect(reads.some(u => u.includes('orgId=o2'))).toBe(true);
    });

    it('names the chosen organisation when a platform admin invites someone into it', async () => {
        const user = userEvent.setup();
        open(platformAdmin, 'invitations', choice('o2'));
        await user.type(await screen.findByPlaceholderText('colleague@example.com'), 'anna@example.com');
        await user.click(screen.getByRole('button', { name: /send/i }));
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u, init]) => String(u).endsWith('/auth/invitations?orgId=o2') && init?.method === 'POST')).toBe(true));
    });

    it('sends an invitation and revokes a pending one', async () => {
        const user = userEvent.setup();
        open(orgAdmin, 'invitations');
        await user.type(await screen.findByPlaceholderText('colleague@example.com'), 'anna@example.com');
        await user.click(screen.getByRole('button', { name: /send/i }));
        await waitFor(() => expect(writes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/auth/invitations' })));
        await user.click(screen.getByTitle('Revoke invitation'));
        await waitFor(() => expect(writes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/auth/invitations/i1' })));
    });

    it('shows the Nextcloud sync tab to a member of a Nextcloud organisation only, for the viewer\'s organisation', async () => {
        open(orgAdmin, 'sync');
        expect(await screen.findByRole('tab', { name: 'Nextcloud sync' })).toBeInTheDocument();
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/auth/admin/o1/nc-sync'))).toBe(true));
    });

    it('leaves the Nextcloud sync tab out for an organisation without a Nextcloud', async () => {
        open({ ...orgAdmin, ncOrg: null }, 'invitations');
        await screen.findByRole('tab', { name: 'Invitations' });
        expect(screen.queryByRole('tab', { name: 'Nextcloud sync' })).not.toBeInTheDocument();
    });

    it('lets a platform admin tell the organisation roles from the server roles', async () => {
        open(platformAdmin, 'users', choice(null));
        expect(await screen.findByRole('tab', { name: 'Organisation roles' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /Server roles/ })).toBeInTheDocument();
    });
});

describe('the people list for an organisation admin', () => {
    it('lets a pending account in', async () => {
        const user = userEvent.setup();
        open(orgAdmin, 'users');
        await user.click(await screen.findByRole('button', { name: /Approve user: Pia/ }));
        await waitFor(() => expect(writes).toContainEqual({ method: 'PUT', path: '/auth/users/u2', body: { status: 'active', orgRole: 'user' } }));
    });

    it('turns a pending account away after asking', async () => {
        const user = userEvent.setup();
        open(orgAdmin, 'users');
        await user.click(await screen.findByRole('button', { name: /Reject user: Pia/ }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
        await waitFor(() => expect(writes).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/auth/users/u2' })));
    });

    it('offers auto-approve for an organisation that signs in through a provider', async () => {
        const user = userEvent.setup();
        open(orgAdmin, 'users');
        await user.click(await screen.findByRole('button', { name: '' }));
        await waitFor(() => expect(writes).toContainEqual({ method: 'PUT', path: '/auth/organizations/o1', body: { autoApproveSSO: true } }));
    });

    it('shows a platform admin the switch of the chosen organisation only', async () => {
        open(platformAdmin, 'users', choice('o2'));
        await screen.findByText('People');
        expect(screen.queryByRole('button', { name: '' })).not.toBeInTheDocument();
    });

    it('shows a platform admin the switch when the chosen organisation signs in through a provider', async () => {
        open(platformAdmin, 'users', choice('o1'));
        expect(await screen.findByRole('button', { name: '' })).toBeInTheDocument();
    });
});

describe('editing a group', () => {
    it('saves the role its members inherit and the tiers they may use, without the id and name', async () => {
        const user = userEvent.setup();
        open(orgAdmin, 'groups');
        await user.click(await screen.findByRole('button', { name: /edit/i }));
        const dialog = await screen.findByRole('dialog');
        await user.selectOptions(within(dialog).getByDisplayValue('User (default)'), ORG_ROLES[0].id);
        await user.click(within(dialog).getByRole('button', { name: /writer/i }));
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(writes).toContainEqual(expect.objectContaining({
            method: 'PUT',
            path: '/auth/groups/g1',
            body: expect.objectContaining({ orgRole: ORG_ROLES[0].id, allowedTiers: ['fast', 'writer'] }),
        })));
        const put = writes.find(w => w.path === '/auth/groups/g1');
        expect(put?.body).not.toHaveProperty('id');
        expect(put?.body).not.toHaveProperty('name');
    });
});
