// The admin dashboard's scope: the bar above every tab, the organisation picker
// (URL ?org=, remembered per browser), the orgId it puts on the lists, and the
// rail's two blocks.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDashboard from './AdminDashboard';
import LicenseContext from '@/components/licensing/LicenseContext';
import { withQueryClient } from '@/test/queryWrapper';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const ORGS = [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }];
const platformAdmin = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'], homeOrganization: null };
const orgAdmin = {
    id: 'u4', isAdmin: false, role: 'user', orgRole: 'org_admin', organizationId: 'org-a', isHomeOrgAdmin: true,
    homeOrganization: { id: 'org-a', name: 'Org A' },
    permissions: ['org_admin', 'admin_security', 'manage_users'],
};

let asked: string[];

beforeEach(() => {
    asked = [];
    window.localStorage.clear();
    window.history.replaceState(null, '', '/app/admin/security');
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        asked.push(address);
        const body = address.includes('/auth/organizations') ? ORGS
            : /\/auth\/(users|groups|roles|permissions)/.test(address) ? [] : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

function renderDashboard({ user = platformAdmin as object, seg1 = 'security', seg2 = 'users', seg3 = '', license = {} as Partial<LicenseValue> } = {}) {
    const value = { tier: 'community', deploymentMode: 'self-hosted', serverOverride: false, hasTier: () => false, hasFeature: () => false, ...license } as LicenseValue;
    const onNavigate = vi.fn();
    render(withQueryClient(
        <LicenseContext.Provider value={value}>
            <AdminDashboard user={user as never} onBack={vi.fn()} onNavigate={onNavigate} adminPath={{ seg1, seg2, seg3 }} />
        </LicenseContext.Provider>,
    ));
    return { onNavigate };
}

const bar = () => screen.getByTestId('admin-scope-bar');
const picker = () => screen.getByRole('combobox', { name: 'Organisation' });
const rail = () => within(screen.getByTestId('admin-rail'));
const userListReads = () => asked.filter(u => u.includes('/auth/users'));
const orgParam = () => new URLSearchParams(window.location.search).get('org');

describe('platform admin: the organisation picker', () => {
    it('starts on all organisations: the bar, the rail line and the lists say so, no orgId is sent', async () => {
        renderDashboard();
        await waitFor(() => expect(picker().querySelectorAll('option')).toHaveLength(3));
        expect(picker()).toHaveValue('');
        expect(bar()).toHaveTextContent('Showing every organisation on this server');
        expect(rail().getByTestId('admin-rail-section-org-subtitle')).toHaveTextContent('All organisations');
        await waitFor(() => expect(userListReads().length).toBeGreaterThan(0));
        expect(userListReads().every(u => !u.includes('orgId='))).toBe(true);
    });

    it('a choice updates the URL, the sentence, the rail line and the orgId on the next list read, and is remembered', async () => {
        const user = userEvent.setup();
        renderDashboard();
        await waitFor(() => expect(picker().querySelectorAll('option')).toHaveLength(3));
        await user.selectOptions(picker(), 'Org B');
        expect(orgParam()).toBe('org-b');
        expect(bar()).toHaveTextContent('Showing Org B only');
        expect(rail().getByTestId('admin-rail-section-org-subtitle')).toHaveTextContent('Org B');
        await waitFor(() => expect(userListReads().at(-1)).toContain('/auth/users?scope=admin&orgId=org-b'));
        expect(asked.some(u => u.includes('/auth/groups?scope=admin&orgId=org-b'))).toBe(true);
        expect(window.localStorage.getItem('beeflow.admin.org')).toBe('org-b');

        await user.selectOptions(picker(), 'All organisations');
        expect(orgParam()).toBeNull();
        expect(window.localStorage.getItem('beeflow.admin.org')).toBeNull();
    });

    it('a reload with ?org= opens on that organisation', async () => {
        window.history.replaceState(null, '', '/app/admin/security?org=org-b');
        renderDashboard();
        await waitFor(() => expect(picker()).toHaveValue('org-b'));
        expect(bar()).toHaveTextContent('Showing Org B only');
        expect(userListReads().every(u => u.includes('orgId=org-b'))).toBe(true);
    });

    it('without ?org= the last choice of this browser comes back, and goes into the URL', async () => {
        window.localStorage.setItem('beeflow.admin.org', 'org-a');
        renderDashboard();
        await waitFor(() => expect(picker()).toHaveValue('org-a'));
        expect(orgParam()).toBe('org-a');
    });

    it('an unknown ?org= falls back to all organisations', async () => {
        window.history.replaceState(null, '', '/app/admin/security?org=gone');
        renderDashboard();
        await waitFor(() => expect(picker().querySelectorAll('option')).toHaveLength(3));
        await waitFor(() => expect(orgParam()).toBeNull());
        expect(picker()).toHaveValue('');
        expect(bar()).toHaveTextContent('Showing every organisation on this server');
        await waitFor(() => expect(userListReads().at(-1)).not.toContain('orgId='));
    });

    it('a stale id waits for the organisation list and never reaches a request', async () => {
        let release: () => void = () => {};
        const listed = new Promise<void>(resolve => { release = resolve; });
        vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
            const address = String(url);
            asked.push(address);
            if (address.includes('/auth/organizations?scope=admin')) await listed;
            const body = address.includes('/auth/organizations') ? ORGS : /\/auth\/(users|groups|roles|permissions)/.test(address) ? [] : {};
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }));
        window.history.replaceState(null, '', '/app/admin/security?org=gone');
        renderDashboard();
        expect(await screen.findByTestId('admin-org-pending')).toBeInTheDocument();
        expect(orgParam()).toBe('gone'); // kept until the list decides
        expect(userListReads()).toEqual([]);
        release();
        await waitFor(() => expect(userListReads().length).toBeGreaterThan(0));
        expect(screen.queryByTestId('admin-org-pending')).not.toBeInTheDocument();
        expect(asked.some(u => u.includes('orgId=gone'))).toBe(false);
        expect(orgParam()).toBeNull();
    });
});

describe('organisation admin', () => {
    it('never gets a picker, reads the organisation by name, and never sends an orgId, whatever the URL says', async () => {
        window.history.replaceState(null, '', '/app/admin/security?org=org-b');
        renderDashboard({ user: orgAdmin });
        await waitFor(() => expect(userListReads().length).toBeGreaterThan(0));
        expect(screen.queryByRole('combobox', { name: 'Organisation' })).not.toBeInTheDocument();
        expect(bar()).toHaveTextContent('Organisation: Org A');
        expect(within(rail().getByTestId('admin-rail-section-org')).getByRole('heading', { name: 'Org A' })).toBeInTheDocument();
        expect(rail().queryByTestId('admin-rail-section-instance')).not.toBeInTheDocument();
        expect(asked.some(u => u.includes('orgId='))).toBe(false);
        expect(orgParam()).toBe('org-b'); // left alone: the URL is not this viewer's state
    });
});

describe('the bar follows the open section', () => {
    it('a server-wide tab of the Users screen switches the bar to the whole server', async () => {
        renderDashboard({ seg3: 'roles' });
        await waitFor(() => expect(bar()).toHaveAttribute('data-kind', 'server'));
        expect(bar()).toHaveTextContent('Changes here apply to every organisation on this server');
    });

    it('a whole-server tab gets the whole-server bar', () => {
        renderDashboard({ seg1: 'modules', seg2: '' });
        expect(bar()).toHaveAttribute('data-kind', 'server');
    });
});

describe('the rail', () => {
    it('shows a platform admin two different blocks: the organisations with their sub-headings, the whole server as one flat list', () => {
        renderDashboard({ seg1: 'modules', seg2: '', license: { tier: 'enterprise', deploymentMode: 'cloud' } });
        const org = within(rail().getByTestId('admin-rail-section-org'));
        const server = within(rail().getByTestId('admin-rail-section-instance'));
        expect(org.getByRole('heading', { name: 'Organisations' })).toBeInTheDocument();
        expect(org.getByText('Security & access')).toBeInTheDocument();
        expect(server.getByRole('heading', { name: 'Whole server' })).toBeInTheDocument();
        // No sub-heading repeats in the server block.
        for (const eyebrow of ['AI & agents', 'Operations', 'Platform', 'Website']) expect(server.queryByText(eyebrow)).not.toBeInTheDocument();
        expect(server.getAllByRole('link').map(a => a.textContent)).toEqual(expect.arrayContaining(['AI Config', 'Modules', 'Support', 'Release Notes']));
    });

    it('keeps the two blocks in the phone drawer', async () => {
        const user = userEvent.setup();
        renderDashboard({ seg1: 'modules', seg2: '' });
        await user.click(screen.getByRole('button', { name: 'Admin sections: Modules' }));
        const drawer = within(await screen.findByRole('dialog', { name: 'Admin sections' }));
        expect(drawer.getByTestId('admin-rail-section-org')).toBeInTheDocument();
        expect(drawer.getByTestId('admin-rail-section-instance')).toBeInTheDocument();
    });

    it('keeps the Organisation sections as rows in the phone drawer, each going to its own address', async () => {
        const user = userEvent.setup();
        const { onNavigate } = renderDashboard({ seg1: 'organisation', seg2: 'encryption' });
        await user.click(screen.getByRole('button', { name: 'Admin sections: Encryption' }));
        const drawer = within(await screen.findByRole('dialog', { name: 'Admin sections' }));
        expect(drawer.getByRole('link', { name: 'Encryption' })).toHaveAttribute('aria-current', 'page');
        await user.click(drawer.getByRole('link', { name: 'MCP Access' }));
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/mcp-access');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
