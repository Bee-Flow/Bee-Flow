// Admin > Agents names each agent's organisation whenever the list spans more
// than one: a platform admin on all organisations, and an organisation admin
// whose groups reach other organisations (GET /agents/all lists the union).
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentConfigHub from './AgentConfigHub';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { withQueryClient } from '@/test/queryWrapper';

const AGENTS = [
    { id: 'a1', name: 'Alpha', owner_id: 'u1', is_published: true, organizationId: 'org-a', organizationName: 'Org A' },
    { id: 'c1', name: 'Gamma', owner_id: 'u1', is_published: true, organizationId: 'org-c', organizationName: 'Org C' },
];

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const body = String(url).includes('/agents/all') ? AGENTS : String(url).includes('/agents/categories') ? [] : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

function choiceOf(over: Partial<AdminOrgChoice>): AdminOrgChoice {
    return {
        isPlatformAdmin: false, orgId: null, orgName: null, organizations: [], organizationsLoaded: true, pending: false,
        homeOrganization: { id: 'org-a', name: 'Org A' }, setOrgId: () => {}, ...over,
    };
}

function renderHub(user: object, choice: AdminOrgChoice) {
    render(withQueryClient(
        <AdminOrgProvider value={choice}>
            <AgentConfigHub user={user} activeSection="chat" />
        </AdminOrgProvider>,
    ));
}

const orgAdmin = (organizations: string[]) => ({ id: 'u1', isAdmin: false, role: 'user', permissions: ['admin_agents'], organizations });

describe('AgentConfigHub: organisation names on the rows', () => {
    it('an organisation admin in several organisations sees whose agent each row is', async () => {
        renderHub(orgAdmin(['org-a', 'org-c']), choiceOf({}));
        expect(await screen.findByText('Gamma')).toBeInTheDocument();
        expect(screen.getAllByTestId('agent-row-org').map(el => el.textContent)).toEqual(['Org A', 'Org C']);
    });

    it('an organisation admin in one organisation gets no names', async () => {
        renderHub(orgAdmin(['org-a']), choiceOf({}));
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-row-org')).not.toBeInTheDocument();
    });

    it('a platform admin: names on all organisations, none with one chosen', async () => {
        const platform = { id: 'u0', isAdmin: true, role: 'admin', permissions: ['all'] };
        const { unmount } = render(withQueryClient(
            <AdminOrgProvider value={choiceOf({ isPlatformAdmin: true, homeOrganization: null })}>
                <AgentConfigHub user={platform} activeSection="chat" />
            </AdminOrgProvider>,
        ));
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        expect(screen.getAllByTestId('agent-row-org')).toHaveLength(2);
        unmount();
        renderHub(platform, choiceOf({ isPlatformAdmin: true, orgId: 'org-a', orgName: 'Org A', homeOrganization: null }));
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-row-org')).not.toBeInTheDocument();
    });
});
