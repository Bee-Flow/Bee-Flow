// The Users screen inside the admin dashboard: its server-wide tabs come last
// and carry the server icon, it tells the dashboard the scope of the open tab,
// and the dashboard's chosen organisation narrows the member lists.
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UserManagement from './UserManagement';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { AdminScopeOverrideProvider } from '@/components/admin/dashboard/useAdminScopeOverride';
import type { AdminScope } from '@/components/admin/dashboard/adminTabs';

const platformAdmin = { id: 'me', permissions: ['all'], isAdmin: true, role: 'admin', organizations: ['o1'] };
const orgAdmin = { id: 'me', permissions: ['manage_users'], isAdmin: false, role: 'user', organizationId: 'o1', organizations: ['o1'] };

let asked: string[];

beforeEach(() => {
    asked = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        asked.push(String(url));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

const choice: AdminOrgChoice = {
    isPlatformAdmin: true, orgId: 'o2', orgName: 'Org Two', organizations: [{ id: 'o1', name: 'Org One' }, { id: 'o2', name: 'Org Two' }],
    organizationsLoaded: true, pending: false, homeOrganization: null, setOrgId: () => {},
};

describe('UserManagement in the admin dashboard', () => {
    it('puts the server-wide tabs last, after a "Whole server" divider, each with the server icon', async () => {
        render(<UserManagement user={platformAdmin} />);
        const tabs = within(await screen.findByRole('tablist'));
        const all = tabs.getAllByRole('tab');
        expect(all.map(tab => tab.textContent?.trim())).toEqual(['Users', 'Groups', 'Organizations', 'Nextcloud', 'Roles', 'Permissions']);
        for (const tab of all.slice(2)) expect(within(tab).getByRole('img', { name: 'Whole server' })).toBeInTheDocument();
        for (const tab of all.slice(0, 2)) expect(within(tab).queryByRole('img')).not.toBeInTheDocument();
        expect(tabs.getAllByText('Whole server', { selector: 'span[aria-hidden="true"]' })).toHaveLength(1);
    });

    it('reports the whole server for a server-wide tab, the tab scope for the others, one organisation for an organisation admin', () => {
        const last = (set: ReturnType<typeof vi.fn>) => set.mock.calls.filter(c => c[0] !== null).at(-1)?.[0] as AdminScope | undefined;
        const roles = vi.fn();
        const { unmount } = render(<AdminScopeOverrideProvider value={roles}><UserManagement user={platformAdmin} activeSection="roles" /></AdminScopeOverrideProvider>);
        expect(last(roles)).toBe('instance');
        unmount();
        const users = vi.fn();
        const second = render(<AdminScopeOverrideProvider value={users}><UserManagement user={platformAdmin} activeSection="users" /></AdminScopeOverrideProvider>);
        expect(last(users)).toBe('mixed');
        second.unmount();
        const own = vi.fn();
        render(<AdminScopeOverrideProvider value={own}><UserManagement user={orgAdmin} /></AdminScopeOverrideProvider>);
        expect(last(own)).toBe('org');
    });

    it('sends the chosen organisation with the user and group lists; the organisation list stays complete', async () => {
        render(<AdminOrgProvider value={choice}><UserManagement user={platformAdmin} /></AdminOrgProvider>);
        await waitFor(() => expect(asked.some(u => u.includes('/auth/users'))).toBe(true));
        expect(asked).toEqual(expect.arrayContaining([
            expect.stringContaining('/auth/users?scope=admin&orgId=o2'),
            expect.stringContaining('/auth/groups?scope=admin&orgId=o2'),
        ]));
        expect(asked.find(u => u.includes('/auth/organizations'))).toMatch(/\/auth\/organizations\?scope=admin$/);
    });
});
