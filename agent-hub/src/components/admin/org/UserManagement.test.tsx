import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UserManagement from './UserManagement';
import { authFetch } from '@/utils/helpers';
import { asMock } from '@/test/mocks';

// UserManagement talks to the network through raw authFetch (not apiClient), so
// mocking utils/helpers is the single seam for the whole panel.
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

const jsonRes = (body: unknown, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

const SYSTEM_ROW = {
    id: 'admin',
    username: 'admin',
    displayName: 'Administrator (System)',
    role: 'admin',
    isSystem: true,
};
const JAN = {
    id: 'u1',
    username: 'jan',
    displayName: 'Jan de Vries',
    email: 'jan@acme.nl',
    role: 'user',
    orgRole: 'org_admin',
    groups: ['g1'],
    organizationId: 'o1',
};

// The admin dashboard's lists carry ?scope=admin; the role table and the permission catalogue do not.
const FIXTURES: Record<string, unknown> = {
    '/auth/users?scope=admin': [SYSTEM_ROW, JAN],
    '/auth/groups?scope=admin': [{ id: 'g1', name: 'Finance', organizationId: 'o1', permissions: [], roles: [] }],
    '/auth/roles': [{ id: 'org_admin', name: 'Org admin', description: '', permissions: [] }],
    '/auth/permissions': [{ id: 'manage_users', name: 'Manage users', category: 'actions' }],
    '/auth/organizations?scope=admin': [
        { id: 'o1', name: 'Acme B.V.', description: 'Test org', registrationSource: 'nextcloud_connector' },
        { id: 'o2', name: 'Legacy Org', description: 'Pre-BFSF-286 org' }, // no registrationSource
    ],
};

const LIST_ENDPOINTS = Object.keys(FIXTURES);

const fullAdmin = { id: 'me', permissions: ['all'], isAdmin: true, organizations: ['o1'] };
const orgScoped = { id: 'me', permissions: ['page_chat'], isAdmin: false, organizations: ['o1'] };
// Holds the 'all' permission inside a tenant, without the platform flag or role.
const allHolder = { id: 'me', permissions: ['all'], isAdmin: false, organizations: ['o1'] };

describe('UserManagement', () => {
    beforeEach(() => {
        cleanup();
        asMock(authFetch).mockReset();
        asMock(authFetch).mockImplementation((url: string) => {
            const hit = LIST_ENDPOINTS.find((p) => url === p);
            return jsonRes(hit ? FIXTURES[hit] : {});
        });
    });

    it('fires the five list endpoints on mount, the directory lists scoped to the admin dashboard', async () => {
        render(<UserManagement user={fullAdmin} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(5));
        expect(asMock(authFetch).mock.calls.map(([url]) => url).sort()).toEqual([...LIST_ENDPOINTS].sort());
    });

    it('asks an organisation-scoped caller for the admin-scoped lists and never the server-wide role table', async () => {
        render(<UserManagement user={allHolder} />);
        await screen.findByText('Jan de Vries');
        const urls = asMock(authFetch).mock.calls.map(([url]) => String(url));
        expect(urls.sort()).toEqual(LIST_ENDPOINTS.filter((u) => u !== '/auth/roles').sort());
    });

    it('offers the org-scoped section set to an \'all\' holder who is not a platform admin', async () => {
        render(<UserManagement user={allHolder} />);
        expect(await screen.findByText('admin.users_tab_my_org')).toBeInTheDocument();
        expect(screen.queryByText('admin.users_tab_roles')).not.toBeInTheDocument();
        expect(screen.queryByText('admin.users_tab_organizations')).not.toBeInTheDocument();
        expect(screen.queryByText('admin.users_tab_nextcloud')).not.toBeInTheDocument();
    });

    // Changed in P1: the old table rendered the synthetic 'admin' row
    // (adminRoutes.js:133-139) with its actions suppressed. PeopleDirectory drops
    // system rows entirely — it groups by organisation, and a system account has
    // none, so it would sit alone under "No organisation" forever.
    it('leaves the synthetic system admin row out of the directory', async () => {
        render(<UserManagement user={fullAdmin} />);
        await screen.findByText('Jan de Vries');
        expect(screen.queryByText('Administrator (System)')).not.toBeInTheDocument();
    });

    it('gives a real person the three row actions', async () => {
        render(<UserManagement user={fullAdmin} />);
        const janRow = (await screen.findByText('Jan de Vries')).closest('[data-testid="people-row"]');
        // edit / reset-2FA / delete — always rendered, not hover-revealed.
        expect(within((janRow as HTMLElement)).getAllByRole('button')).toHaveLength(3);
    });

    // t() is stubbed to the identity here, so assertions match the key rather
    // than the English copy.
    it('shows Add user to someone who can manage users', async () => {
        render(<UserManagement user={fullAdmin} />);
        expect(await screen.findAllByText('admin.sec_people_add')).not.toHaveLength(0);
    });

    it('hides Add user from someone who cannot manage users', async () => {
        render(<UserManagement user={orgScoped} />);
        await screen.findByText('Jan de Vries');
        expect(screen.queryByText('admin.sec_people_add')).not.toBeInTheDocument();
    });

    it('offers the full-admin section set to a full admin', async () => {
        render(<UserManagement user={fullAdmin} />);
        for (const key of ['users', 'organizations', 'nextcloud', 'groups', 'roles', 'permissions']) {
            expect(await screen.findByText(`admin.users_tab_${key}`)).toBeInTheDocument();
        }
        expect(screen.queryByText('admin.users_tab_my_org')).not.toBeInTheDocument();
    });

    it('offers the org-scoped section set to an org-scoped user', async () => {
        render(<UserManagement user={orgScoped} />);
        expect(await screen.findByText('admin.users_tab_users')).toBeInTheDocument();
        expect(screen.getByText('admin.users_tab_groups')).toBeInTheDocument();
        expect(screen.getByText('admin.users_tab_my_org')).toBeInTheDocument();
        expect(screen.queryByText('admin.users_tab_roles')).not.toBeInTheDocument();
        expect(screen.queryByText('admin.users_tab_organizations')).not.toBeInTheDocument();
    });

    it('navigates on section switch instead of holding local tab state', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        render(<UserManagement user={fullAdmin} onNavigate={onNavigate} />);
        await user.click(await screen.findByRole('tab', { name: 'admin.users_tab_groups' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/security/users/groups');
    });

    it('marks the section from the URL as the selected tab', async () => {
        render(<UserManagement user={fullAdmin} activeSection="roles" />);
        const tabs = await screen.findByRole('tablist', { name: 'admin.sec_users' });
        expect(within(tabs).getByRole('tab', { name: 'admin.users_tab_roles admin.scope_instance' })).toHaveAttribute('aria-selected', 'true');
        expect(within(tabs).getByRole('tab', { name: 'admin.users_tab_users' })).toHaveAttribute('aria-selected', 'false');
    });

    it('names the row actions of a role after the role', async () => {
        render(<UserManagement user={fullAdmin} activeSection="roles" />);
        expect(await screen.findByRole('button', { name: 'common.edit Org admin' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'common.delete Org admin' })).toBeInTheDocument();
    });

    it('falls back to the users section for an unknown activeSection', async () => {
        render(<UserManagement user={fullAdmin} activeSection="nope" />);
        expect(await screen.findByText('admin.sec_people_title')).toBeInTheDocument();
    });

    // Regression: the my-organization form used to be seeded by a
    // `setTimeout(() => setOrgData(editData), 0)` called from inside the render
    // path, which re-fired on every render until the state landed.
    it('seeds the my-organization form from the caller org, without a render-time side effect', async () => {
        render(<UserManagement user={orgScoped} activeSection="my-organization" />);
        expect(await screen.findByDisplayValue('Acme B.V.')).toBeInTheDocument();
    });

    // The organisations arrive in id order; the caller's own organisation wins
    // over one they only belong to through a group, whatever its id.
    it('seeds the my-organization form from the home org, not the first org in the list', async () => {
        const memberOfBoth = { ...orgScoped, organizationId: 'o2', organizations: ['o1', 'o2'] };
        render(<UserManagement user={memberOfBoth} activeSection="my-organization" />);
        expect(await screen.findByDisplayValue('Legacy Org')).toBeInTheDocument();
        expect(screen.queryByDisplayValue('Acme B.V.')).not.toBeInTheDocument();
    });

    // BFSF-286: every org card shows its registration source; orgs from before
    // the backfill (no registrationSource) surface as "unknown" instead of
    // being silently mislabelled. Connector orgs also name their terms channel.
    it('labels each organization with its registration source', async () => {
        render(<UserManagement user={fullAdmin} activeSection="organizations" />);
        await screen.findByText('Acme B.V.');
        expect(screen.getAllByText(/admin\.org_source_label/)).toHaveLength(2);
        expect(screen.getByText(/admin\.org_source_nextcloud_connector/)).toBeInTheDocument();
        expect(screen.getByText(/admin\.org_source_unknown/)).toBeInTheDocument();
    });

    // A directory permission without administration of the home organisation:
    // the admin-scoped lists answer 403, and the screen says who it is for.
    it('says who the page is for when the admin-scoped lists are refused', async () => {
        asMock(authFetch).mockImplementation((url: string) => (String(url).includes('scope=admin')
            ? jsonRes({ error: 'Organization admin access required', code: 'org_admin_required' }, 403)
            : jsonRes(FIXTURES[url] ?? {})));
        const directoryHolder = { id: 'me', permissions: ['manage_users'], isAdmin: false, organizations: ['o1'] };
        render(<UserManagement user={directoryHolder} />);
        expect((await screen.findByText('admin_org.user_mgmt_org_admins_only')).closest('[role="status"]')).not.toBeNull();
        expect(screen.getByText('admin.sec_people_title')).toBeInTheDocument();
        // The server refuses the edits as it refused the lists, so no control offers one.
        expect(screen.queryByText('admin.sec_people_add')).not.toBeInTheDocument();
    });

    // The scoped list also holds members of the organisation's groups whose
    // home is elsewhere (or nowhere); the server manages an account through its
    // home organisation only.
    it('lists a member through a group alone read-only for an organisation admin', async () => {
        const bob = { id: 'u2', username: 'bob', displayName: 'Bob Visser', role: 'user', orgRole: 'member', groups: ['g1'], organizationId: 'o2' };
        asMock(authFetch).mockImplementation((url: string) => jsonRes(url === '/auth/users?scope=admin' ? [JAN, bob] : (FIXTURES[url] ?? {})));
        const orgAdmin = { id: 'me', permissions: ['manage_users'], isAdmin: false, organizationId: 'o1', orgRole: 'org_admin', organizations: ['o1'] };
        render(<UserManagement user={orgAdmin} />);
        const bobRows = (await screen.findAllByText('Bob Visser')).map((el) => el.closest('[data-testid="people-row"]') as HTMLElement);
        for (const row of bobRows) expect(within(row).queryAllByRole('button')).toHaveLength(0);
        const janRow = screen.getByText('Jan de Vries').closest('[data-testid="people-row"]') as HTMLElement;
        expect(within(janRow).getAllByRole('button')).toHaveLength(3);
    });

    it('keeps that sentence away from a viewer whose lists load', async () => {
        render(<UserManagement user={orgScoped} />);
        await screen.findByText('Jan de Vries');
        expect(screen.queryByText('admin_org.user_mgmt_org_admins_only')).not.toBeInTheDocument();
    });

    it('reports a load failure rather than rendering an empty table', async () => {
        asMock(authFetch).mockReset();
        asMock(authFetch).mockRejectedValue(new Error('offline'));
        render(<UserManagement user={fullAdmin} />);
        expect((await screen.findByText('Failed to load data. Ensure you are admin.')).closest('[role="status"]')).not.toBeNull();
    });
});
