// Subscriptions → Organizations. Pinned: "Remove subscription" inside the
// editor asks for confirmation right there (the dialog used to exist only in
// the list view, so the button did nothing until the admin went back).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { OrgsView } from './OrgsView';
import { renderWithClient } from '@/test/render';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { setDemoTransport(null); });

describe('OrgsView', () => {
    it('confirms and removes a subscription from inside its editor', async () => {
        const user = userEvent.setup();
        const calls: string[] = [];
        setDemoTransport(async (url: unknown, options?: RequestInit) => {
            const address = String(url);
            calls.push(`${options?.method || 'GET'} ${address}`);
            if (address.endsWith('/auth/organizations')) return json([{ id: 'o1', name: 'Acme' }]);
            if (address.endsWith('/api/subscriptions/orgs')) return json([{ organization_id: 'o1', org_name: 'Acme', plan_id: 'p1', plan_name: 'Team', status: 'active' }]);
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Team' }]);
            return json({ features: [] });
        });
        renderWithClient(<OrgsView />);
        await user.click(await screen.findByText('Acme'));
        expect(await screen.findByText('Organization subscription')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Remove subscription' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain("Remove Acme's subscription?");
        // Still in the editor: the question is asked where the button is.
        expect(screen.getByText('Organization subscription')).toBeTruthy();

        const confirm = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.includes('Remove subscription'));
        await user.click(confirm as HTMLButtonElement);
        await waitFor(() => expect(calls.some(c => c.startsWith('DELETE ') && c.endsWith('/api/subscriptions/orgs/o1'))).toBe(true));
    });

    it('shows the subscriptions as a sortable table and a filter without matches inside it', async () => {
        const user = userEvent.setup();
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            if (address.endsWith('/auth/organizations')) return json([{ id: 'o1', name: 'Acme' }, { id: 'o2', name: 'Zeta' }]);
            if (address.endsWith('/api/subscriptions/orgs')) return json([
                { organization_id: 'o1', org_name: 'Acme', plan_name: 'Team', status: 'active', current_usage: { messages: 10 } },
                { organization_id: 'o2', org_name: 'Zeta', plan_name: null, status: 'trialing', current_usage: { messages: 500 } },
            ]);
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Team' }]);
            return json({ features: [] });
        });
        renderWithClient(<OrgsView />);
        const table = await screen.findByRole('table', { name: 'Active subscriptions' });
        const first = () => within(table).getAllByRole('row')[1].textContent;
        expect(first()).toContain('Acme');
        await user.click(within(table).getByRole('button', { name: 'Messages' }));
        expect(first()).toContain('Zeta');
        expect(first()).toContain('Custom');
        await user.click(screen.getByRole('button', { name: 'Suspended' }));
        expect(within(table).getByText('No matches')).toBeInTheDocument();
    });

    it('labels and filters a subscription whose dunning reached the cap, and keeps that status in its editor', async () => {
        const user = userEvent.setup();
        setDemoTransport(async (url: unknown) => {
            const address = String(url);
            if (address.endsWith('/auth/organizations')) return json([{ id: 'o1', name: 'Acme' }, { id: 'o2', name: 'Zeta' }]);
            if (address.endsWith('/api/subscriptions/orgs')) return json([
                { organization_id: 'o1', org_name: 'Acme', plan_id: 'p1', plan_name: 'Team', status: 'manual_action_required' },
                { organization_id: 'o2', org_name: 'Zeta', plan_id: 'p1', plan_name: 'Team', status: 'active' },
            ]);
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Team' }]);
            return json({ features: [] });
        });
        renderWithClient(<OrgsView />);
        const table = await screen.findByRole('table', { name: 'Active subscriptions' });
        expect(within(table).getByText('Action required')).toBeInTheDocument();
        expect(within(table).queryByText('manual_action_required')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Action required' }));
        expect(within(table).getByText('Acme')).toBeInTheDocument();
        expect(within(table).queryByText('Zeta')).toBeNull();

        await user.click(within(table).getByText('Acme'));
        const option = await screen.findByRole('option', { name: 'Payment action required' });
        expect((option as HTMLOptionElement).selected).toBe(true);
    });

    it('saves an override that was switched on but left empty as no override, never as a cap of 0', async () => {
        const user = userEvent.setup();
        const saved: Array<Record<string, unknown>> = [];
        setDemoTransport(async (url: unknown, options?: RequestInit) => {
            const address = String(url);
            if (options?.method === 'PUT') { saved.push(JSON.parse(String(options.body))); return json({}); }
            if (address.endsWith('/auth/organizations')) return json([{ id: 'o1', name: 'Acme' }]);
            if (address.endsWith('/api/subscriptions/orgs')) return json([{ organization_id: 'o1', org_name: 'Acme', plan_id: 'p1', plan_name: 'Team', status: 'active' }]);
            // The plan sets no limits, so "Override" has no plan value to start from.
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Team' }]);
            return json({ features: [] });
        });
        renderWithClient(<OrgsView />);
        await user.click(await screen.findByText('Acme'));
        const overrides = await screen.findAllByText('Override');
        await user.click(overrides[1]); // Max users
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        // The server coerces '' to the number 0, which would lock the organisation out.
        // Empty is "no override", the same as before, so nothing is sent for it.
        expect(saved[0]).toEqual({});
    });

    it('does not send the loaded stale limits back on save (BFSF-249)', async () => {
        const user = userEvent.setup();
        const saved: Array<Record<string, unknown>> = [];
        setDemoTransport(async (url: unknown, options?: RequestInit) => {
            const address = String(url);
            if (options?.method === 'PUT') { saved.push(JSON.parse(String(options.body))); return json({}); }
            if (address.endsWith('/auth/organizations')) return json([{ id: 'o1', name: 'Acme' }]);
            if (address.endsWith('/api/subscriptions/orgs')) return json([{ organization_id: 'o1', org_name: 'Acme', plan_id: 'p1', plan_name: 'Free', status: 'active', max_agents: 5, max_knowledge_sources: 3 }]);
            if (address.endsWith('/api/subscriptions/plans')) return json([{ id: 'p1', name: 'Free' }, { id: 'p2', name: 'Launch' }]);
            return json({ features: [] });
        });
        renderWithClient(<OrgsView />);
        await user.click(await screen.findByText('Acme'));
        await screen.findByText('Organization subscription');
        await user.selectOptions(screen.getAllByRole('combobox')[0], 'p2');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(saved).toHaveLength(1));
        // Without explicit limits in the body the server clears the old overrides.
        expect(saved[0]).toEqual({ plan_id: 'p2' });
    });
});
