// The cloud ceiling under an organisation's heading is read-only: the plan the
// organisation is on, as a chip, with a link to the one place plans are
// assigned and edited (Whole server > Subscriptions, the organisations
// section). Neither a plan picker nor the plan editor is embedded.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CloudCeilingEditor from './CloudCeilingEditor';
import { withQueryClient } from '@/test/queryWrapper';
import { withShell } from '@/test/shellProviders';

const navigate = vi.fn();
let orgs: { organization_id: string; plan_id: string | null }[];

beforeEach(() => {
    navigate.mockReset();
    orgs = [{ organization_id: 'org-b', plan_id: 'p1' }, { organization_id: 'org-c', plan_id: 'p1' }];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const address = String(url);
        const body = address.endsWith('/api/subscriptions/plans') ? [{ id: 'p1', name: 'Pro' }]
            : address.endsWith('/api/subscriptions/orgs') ? orgs
                : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
});

describe('CloudCeilingEditor', () => {
    it('shows the plan read-only and links to the organisations of Subscriptions', async () => {
        const user = userEvent.setup();
        render(withQueryClient(withShell(<CloudCeilingEditor orgId="org-b" orgName="Org B" />, { onNavigate: navigate })));
        expect(await screen.findByTestId('ceiling-plan-chip')).toHaveTextContent('Pro');
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(screen.queryByRole('button', { name: /Edit plan/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: /Manage in Subscriptions/ }));
        expect(navigate).toHaveBeenCalledWith('admin/subscriptions/organizations');
    });

    it('says "No plan" for an organisation without one', async () => {
        orgs = [];
        render(withQueryClient(withShell(<CloudCeilingEditor orgId="org-b" orgName="Org B" />, { onNavigate: navigate })));
        expect(await screen.findByTestId('ceiling-plan-chip')).toHaveTextContent('No plan');
    });

    it('writes nothing', async () => {
        render(withQueryClient(withShell(<CloudCeilingEditor orgId="org-b" orgName="Org B" />, { onNavigate: navigate })));
        await screen.findByTestId('ceiling-plan-chip');
        const calls = vi.mocked(fetch).mock.calls;
        expect(calls.every(([, init]) => ((init as RequestInit | undefined)?.method || 'GET') === 'GET')).toBe(true);
    });
});
