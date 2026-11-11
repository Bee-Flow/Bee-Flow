// The Access panel takes its organisation from the admin dashboard's picker. It
// no longer saves an organisation on mount; only a change of the picker while
// the panel is open writes the session's selected organisation.
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AccessPermissionsPanel from './AccessPermissionsPanel';
import { AdminOrgProvider, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { withQueryClient } from '@/test/queryWrapper';

const ORGS = [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }];
const platformAdmin = { id: 'u1', isAdmin: true, role: 'admin', permissions: ['all'] };

const MATRIX = {
    orgId: 'org-a',
    mode: 'cloud',
    capabilities: [
        { id: 'webpages', kind: 'beta', name: 'Webpages', category: 'Beta' },
        { id: 'slack', kind: 'integration', name: 'Slack', category: 'Chat' },
    ],
    ceiling: ['webpages', 'slack'],
    everyone: [],
    groups: [],
};

let calls: { method: string; url: string; body: string | null }[];

beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit = {}) => {
        calls.push({ method: init.method || 'GET', url: String(url), body: typeof init.body === 'string' ? init.body : null });
        const body = String(url).includes('group-access') ? MATRIX : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

const writes = () => calls.filter(c => c.method === 'PUT' && c.url.includes('/auth/admin/selected-org'));

function choiceOf(orgId: string | null): AdminOrgChoice {
    return {
        isPlatformAdmin: true, orgId, orgName: ORGS.find(o => o.id === orgId)?.name ?? null, organizations: ORGS,
        organizationsLoaded: true, pending: false, homeOrganization: null, setOrgId: () => {},
    };
}

function panel(orgId: string | null) {
    return withQueryClient(
        <AdminOrgProvider value={choiceOf(orgId)}>
            <AccessPermissionsPanel user={platformAdmin} activeSection="grants" />
        </AdminOrgProvider>,
    );
}

describe('AccessPermissionsPanel and the dashboard organisation', () => {
    it('writes nothing on mount, also with an organisation chosen', async () => {
        render(panel('org-a'));
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(writes()).toEqual([]);
        // Its own organisation list is gone: the dashboard's picker holds it.
        expect(calls.some(c => /\/auth\/organizations(\?|$)/.test(c.url))).toBe(false);
    });

    it('asks for a choice under "All organisations" instead of picking one', async () => {
        render(panel(null));
        expect(screen.getByTestId('admin-choose-org')).toHaveTextContent('Choose an organisation above to manage its access');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(writes()).toEqual([]);
    });

    it('a change of the picker while the panel is open saves the chosen organisation once; "All organisations" saves nothing', async () => {
        const { rerender } = render(panel('org-a'));
        rerender(panel('org-b'));
        await waitFor(() => expect(writes()).toHaveLength(1));
        expect(JSON.parse(writes()[0].body as string)).toEqual({ orgId: 'org-b' });
        rerender(panel(null));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(writes()).toHaveLength(1);
        expect(screen.getByTestId('admin-choose-org')).toBeInTheDocument();
    });

    it('an organisation admin gets their own organisation and no write', async () => {
        render(withQueryClient(<AccessPermissionsPanel user={{ id: 'u2', isAdmin: false, role: 'user', permissions: ['org_admin'] }} activeSection="grants" />));
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByTestId('admin-choose-org')).not.toBeInTheDocument();
        expect(writes()).toEqual([]);
    });

    it('an organisation admin manages the integrations next to the features and betas', async () => {
        render(withQueryClient(<AccessPermissionsPanel user={{ id: 'u2', isAdmin: false, role: 'user', permissions: ['org_admin'] }} activeSection="grants" />));
        expect(await screen.findByRole('checkbox', { name: 'Slack' })).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Webpages' })).toBeInTheDocument();
        expect(calls.some(c => c.url.includes('/auth/me/group-access'))).toBe(true);
    });
});
