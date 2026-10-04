import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import AutomationTile, { automationHref, stepCountOf } from './AutomationTile';
import { authFetch } from '../../../../../utils/helpers';

/**
 * The automation tile is a claim-making surface: it says how big an automation is, how
 * often it ran, and where it lives. Every one of those can be unavailable, and
 * an unavailable fact must render as NOTHING — never as a zero, a dash, or an
 * id standing in for a name.
 */

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = () => ({ ok: false, status: 500, json: async () => ({}) });

function renderTile(props) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <AutomationTile automationId="aut_1" onChoose={() => {}} {...props} />
        </QueryClientProvider>,
    );
    return { ...utils, client };
}

/**
 * Wait until the runs query has actually SETTLED.
 *
 * Without this, every "no run count is shown" assertion below was vacuous: the
 * step count comes straight from the row and renders on the first paint, so
 * `waitFor(/1 steps/)` returns before the facets request has resolved, and
 * `queryByText(/runs/)` was reading a tile that had not had the chance to show
 * a number yet. Proven: making runCountOf return a constant 7 for every input
 * left all four negative assertions green.
 *
 * The query's own state is the only honest signal that the tile has had its
 * answer and chose to render nothing.
 */
async function runsSettled(client, automationId = 'aut_1') {
    await waitFor(() => {
        const state = client.getQueryState(['studio-app-automation-runs', automationId]);
        expect(state?.status, 'the runs query never settled').not.toBe('pending');
        expect(state?.fetchStatus).toBe('idle');
    });
}

describe('stepCountOf — null and zero are different answers', () => {
    it('counts the top-level steps', () => {
        expect(stepCountOf({ definition: { steps: [{}, {}, {}] } })).toBe(3);
    });

    it('returns null — not 0 — when the definition never arrived', () => {
        // "0 steps" for an automation whose definition was not loaded is a claim
        // the tile cannot back up, and it reads as a broken automation.
        expect(stepCountOf({ title: 'x' })).toBeNull();
        expect(stepCountOf(null)).toBeNull();
        expect(stepCountOf({ definition: { steps: 'nope' } })).toBeNull();
    });

    it('reports a genuinely empty automation as 0', () => {
        expect(stepCountOf({ definition: { steps: [] } })).toBe(0);
    });
});

describe('automationHref', () => {
    it('points at the automation inside the Automations builder', () => {
        expect(automationHref('aut_1')).toBe('/app/studio/automations/aut_1');
    });

    it('is null with no automation — a link to nowhere is worse than no link', () => {
        expect(automationHref(null)).toBeNull();
    });

    it('carries the button it was opened from, so the builder can draw the way back (P4)', () => {
        expect(automationHref('aut_1', { appId: 'app-1', screenId: 'scr_dash01', nodeId: 'cmp_btn123' }))
            .toBe('/app/studio/automations/aut_1?from=app%3Aapp-1%3Ascr_dash01%3Acmp_btn123');
    });

    it('drops a reference that is not whole rather than minting a broken query', () => {
        expect(automationHref('aut_1', { appId: 'app-1', screenId: 'scr_dash01' })).toBe('/app/studio/automations/aut_1');
        expect(automationHref('aut_1', null)).toBe('/app/studio/automations/aut_1');
    });
});

describe('AutomationTile — every fact degrades on its own', () => {
    beforeEach(() => { authFetch.mockReset(); });
    afterEach(() => { vi.clearAllMocks(); });

    it('shows the step count and the run count, and calls the window what it is', async () => {
        authFetch.mockImplementation(async (url) => (String(url).includes('/facets')
            ? ok({ facets: { automationId: { aut_1: 38 } } })
            : ok([])));
        renderTile({ row: { id: 'aut_1', title: 'Work out the quote', definition: { steps: [{}, {}] } } });

        expect(screen.getByText('Work out the quote')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText(/38 runs in the last 24 hours/)).toBeInTheDocument());
        expect(screen.getByText(/2 steps/)).toBeInTheDocument();
        // NOT "today". The endpoint counts a rolling 24-hour window, and a
        // label that says one while counting the other is a lie.
        expect(screen.queryByText(/today/i)).toBeNull();
    });

    it('shows no run count at all when the count cannot be fetched', async () => {
        authFetch.mockResolvedValue(fail());
        const { client } = renderTile({ row: { id: 'aut_1', title: 'Quote', definition: { steps: [{}] } } });
        await waitFor(() => expect(screen.getByText(/1 steps/)).toBeInTheDocument());
        await runsSettled(client);
        expect(screen.queryByText(/runs/i)).toBeNull();
        expect(screen.queryByText(/0 runs/)).toBeNull();
    });

    it('shows no run count when the facets came back without this automation in them', async () => {
        // The other half of the runs degradation, and the half a failed fetch
        // does NOT exercise: the request succeeded, but the payload carries no
        // number for this automation (a partial facet map, a value that is not a
        // number). Absent is not zero. Rendering "0 runs in the last 24 hours"
        // there is a claim about an automation's traffic that the response never
        // made — and it reads as "nobody uses this", which is a reason people
        // delete things.
        authFetch.mockImplementation(async (url) => (String(url).includes('/facets')
            ? ok({ facets: { automationId: { aut_other: 12 } } })
            : ok([])));
        const { client } = renderTile({ row: { id: 'aut_1', title: 'Quote', definition: { steps: [{}] } } });
        await waitFor(() => expect(screen.getByText(/1 steps/)).toBeInTheDocument());
        await runsSettled(client);
        expect(screen.queryByText(/runs/i)).toBeNull();
    });

    it('shows no run count when the count is not a number', async () => {
        authFetch.mockImplementation(async (url) => (String(url).includes('/facets')
            ? ok({ facets: { automationId: { aut_1: 'lots' } } })
            : ok([])));
        const { client } = renderTile({ row: { id: 'aut_1', title: 'Quote', definition: { steps: [{}] } } });
        await waitFor(() => expect(screen.getByText(/1 steps/)).toBeInTheDocument());
        await runsSettled(client);
        expect(screen.queryByText(/runs/i)).toBeNull();
    });

    it('names no solution when the project lookup fails', async () => {
        authFetch.mockImplementation(async (url) => (String(url).includes('/api/projects') ? fail() : ok({ facets: {} })));
        renderTile({ row: { id: 'aut_1', title: 'Quote', projectId: 'prj_9', definition: { steps: [{}] } } });
        await waitFor(() => expect(screen.getByText(/1 steps/)).toBeInTheDocument());
        // An id in place of a name is not a degraded name, it is a different
        // claim — the tile says nothing instead.
        expect(screen.queryByText(/prj_9/)).toBeNull();
        expect(screen.queryByText(/^in /)).toBeNull();
    });

    it('renders no facts line at all when it knows nothing about the automation', async () => {
        authFetch.mockResolvedValue(fail());
        const { client } = renderTile({ row: null });
        await waitFor(() => expect(screen.getByText('This automation')).toBeInTheDocument());
        await runsSettled(client);
        expect(screen.queryByText(/steps/)).toBeNull();
        expect(screen.queryByText(/runs/)).toBeNull();
    });

    it('with no automation chosen, offers the picker and fetches nothing', async () => {
        renderTile({ automationId: null, row: null });
        expect(screen.getByText(/choose an automation/i)).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('does not ask for projects when the automation is in none', async () => {
        authFetch.mockResolvedValue(ok({ facets: {} }));
        renderTile({ row: { id: 'aut_1', title: 'Quote', definition: { steps: [] } } });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        const urls = authFetch.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/projects'))).toBe(false);
    });
});
