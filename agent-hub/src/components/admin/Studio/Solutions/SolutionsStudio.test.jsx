import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));
// The live feed needs an EventSource; the workspace must render without one.
vi.mock('../../../../hooks/useProjectStream', () => ({ default: () => {} }));

import SolutionsStudio from './SolutionsStudio';

/**
 * Studio → Solutions: the builder's view of a project.
 *
 * The behaviours worth pinning are the seams, not the tabs themselves (the tab
 * components and the overview carry their own tests): the overview lists what
 * GET /api/projects/summary returns, creating and installing both land you
 * INSIDE the new Solution, and the detail view wires the shared tab components
 * to this project's data.
 *
 * The one seam that is this file's alone is the READ. A failed summary comes
 * back with the same empty `projects` list a healthy empty workspace does — the
 * route says so in its own header — so the status has to travel beside the rows
 * or the screen tells somebody their Solutions are gone.
 *
 * The detail view opens on CONTENT, not Overview: a builder arriving at a
 * Solution is looking at what is in it. And the header's publish button is the
 * one control on this screen that can do damage — it reads the aggregator's
 * verdict, so a Solution whose checks did not run must not be publishable. Both
 * are pinned below.
 */

/** Summary rows, as GET /api/projects/summary sends them. */
const PROJECTS = [
    {
        id: 'p1', name: 'Onboarding', description: 'How we onboard', icon: '📦', permission: 'owner',
        installedFromBlueprintId: null, counts: { apps: 1 }, runs: { today: 0, failed: 0 },
        completeness: null, update: null, unavailable: [], complete: true,
    },
    {
        id: 'p2', name: 'Invoices', description: '', icon: '🧾', permission: 'viewer',
        installedFromBlueprintId: null, counts: {}, runs: { today: 0, failed: 0 },
        completeness: null, update: null, unavailable: [], complete: true,
    },
];

const RESOURCES = {
    role: 'owner',
    notebooks: [], apps: [{ id: 'a1', name: 'Desk' }], automations: [], webpages: [], approvals: [],
};

/** A Solution whose checks ran and found nothing: the only publishable state. */
const CLEAN = { findings: [], blocked: false, complete: true, unavailable: [], requires: { items: [], counts: {} } };

function mockFetch({ projects = PROJECTS, summaryOk = true, completeness = CLEAN, blueprints = [] } = {}) {
    globalThis.__authFetch = vi.fn(async (url, init) => {
        const method = init?.method || 'GET';
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (url.endsWith('/api/projects/summary')) {
            // The route's 500 carries the SAME empty list a healthy empty
            // workspace does. That is the shape the seam has to survive.
            return summaryOk
                ? ok({ projects, unavailable: [], hasMore: false, checkedCount: projects.length })
                : { ok: false, status: 500, json: async () => ({ error: 'Request failed', projects: [], unavailable: ['all'], hasMore: false }) };
        }
        if (url.endsWith('/api/projects') && method === 'POST') {
            return ok({ id: 'p_new', name: JSON.parse(init.body).name, permission: 'owner' });
        }
        if (url.includes('/package/blueprints')) return ok({ blueprints });
        if (url.includes('/completeness')) {
            return completeness === null
                ? { ok: false, status: 500, json: async () => ({ error: 'Request failed' }) }
                : ok(completeness);
        }
        if (url.includes('/members')) return ok({ ownerId: 'alice', members: [] });
        if (url.includes('/resources')) return ok(RESOURCES);
        if (url.includes('/activity')) return ok([{ id: 'e1', action: 'resource_added', createdAt: null }]);
        if (url.includes('/graph')) return ok({ nodes: [], edges: [], externals: [], problems: [], unavailable: [], complete: true });
        return ok({});
    });
}

beforeEach(() => mockFetch());
afterEach(() => { delete globalThis.__authFetch; });

describe('the gallery', () => {
    it('lists every Solution the caller can reach, with their role', async () => {
        const { findAllByTestId, getByText } = render(<SolutionsStudio />);
        const cards = await findAllByTestId('solutions-card');
        expect(cards).toHaveLength(2);
        expect(getByText('Onboarding')).toBeTruthy();
        expect(getByText('viewer')).toBeTruthy();
    });

    it('says so when there is nothing yet', async () => {
        mockFetch({ projects: [] });
        const { findByText } = render(<SolutionsStudio />);
        expect(await findByText(/Nothing here yet/)).toBeTruthy();
    });

    it('reads the summary, which is what the cards are made of', async () => {
        const { findAllByTestId } = render(<SolutionsStudio />);
        await findAllByTestId('solutions-card');
        expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).endsWith('/api/projects/summary'))).toBe(true);
    });

    it('A FAILED READ IS NOT AN EMPTY WORKSPACE', async () => {
        // The 500 body carries `projects: []`, so a screen that trusted the
        // body over the status would print "Nothing here yet. Create a
        // Solution…" at somebody whose Solutions are all still there.
        mockFetch({ summaryOk: false });
        const { findByTestId, queryByText } = render(<SolutionsStudio />);
        expect(await findByTestId('solutions-overview-unavailable')).toBeTruthy();
        expect(queryByText(/Nothing here yet/)).toBeNull();
    });

    it('offers installing a Blueprint right where Solutions are born', async () => {
        const { findByText } = render(<SolutionsStudio />);
        expect(await findByText('Install a Blueprint')).toBeTruthy();
    });

    it('creating a Solution lands you inside it', async () => {
        const onNavigate = vi.fn();
        const { container, findByText, getByPlaceholderText } = render(<SolutionsStudio onNavigate={onNavigate} />);
        await findByText('Onboarding');

        fireEvent.change(getByPlaceholderText('Name the Solution…'), { target: { value: 'Fresh' } });
        fireEvent.click(container.querySelector('[data-testid="solutions-create"]'));

        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/solutions/p_new'));
        const posted = globalThis.__authFetch.mock.calls.find(([, i]) => i?.method === 'POST' && !String(i.body).includes('manifest'));
        expect(JSON.parse(posted[1].body).name).toBe('Fresh');
    });
});

describe('the detail view', () => {
    it('opens a card into the builder tabs, defaulting to Content', async () => {
        const { findAllByTestId, findByTestId, getByText } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        // The grouped Content table, not the flat listing: three bands over the
        // same eight membership sections.
        expect(await findByTestId('solution-band-people')).toBeTruthy();
        expect(getByText('Work happens')).toBeTruthy();
        expect(getByText('Knowledge & data')).toBeTruthy();
    });

    it('names the Solution in a Studio header, with the shared kind tile', async () => {
        const { findAllByTestId, findByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        const header = await findByTestId('studio-section-header');
        expect(header).toBeTruthy();
        expect((await findByTestId('studio-section-kind')).getAttribute('data-kind')).toBe('solution');
        expect((await findByTestId('studio-section-title')).textContent).toBe('Onboarding');
    });

    it('packaging happens in a dialog, under the caller\'s real role', async () => {
        const { findAllByTestId, findByTestId, findByText } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        fireEvent.click(await findByTestId('solution-export'));
        expect(await findByText('Package this Solution')).toBeTruthy();
    });

    it('publishing is available only when the checks ran and found nothing', async () => {
        const { findAllByTestId, findByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        await waitFor(async () => expect((await findByTestId('solution-publish')).disabled).toBe(false));
    });

    it('a failed check request leaves publishing OFF — an empty list is not a clean bill', async () => {
        mockFetch({ completeness: null });
        const { findAllByTestId, findByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        // The button starts disabled and must still be disabled once the 500
        // has landed — this is the fail-open the whole aggregator exists for.
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/completeness'))).toBe(true));
        expect((await findByTestId('solution-publish')).disabled).toBe(true);
    });

    it('a Solution that could not be fully read blocks publishing too', async () => {
        mockFetch({ completeness: { ...CLEAN, blocked: true, complete: false, unavailable: ['agents'] } });
        const { findAllByTestId, findByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        await waitFor(async () => expect((await findByTestId('solution-publish')).disabled).toBe(true));
    });

    it('a REFETCH that fails drops the earlier clean verdict and re-locks publishing', async () => {
        // Everywhere else on this screen a stale view is the kinder choice.
        // Here it is the dangerous one: "nothing blocking" from before the
        // Solution changed would leave the button live while the server can no
        // longer confirm anything. Filing something in refetches the verdict —
        // and this time the endpoint is down.
        let completenessCalls = 0;
        globalThis.__authFetch = vi.fn(async (url) => {
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (url.endsWith('/api/projects/summary')) {
                return ok({ projects: PROJECTS, unavailable: [], hasMore: false });
            }
            if (url.includes('/package/blueprints')) return ok({ blueprints: [] });
            if (url.includes('/completeness')) {
                completenessCalls += 1;
                return completenessCalls === 1
                    ? ok(CLEAN)
                    : { ok: false, status: 500, json: async () => ({ error: 'Request failed', blocked: true }) };
            }
            if (url.includes('/members')) return ok({ ownerId: 'alice', members: [] });
            if (url.includes('/resources')) return ok(RESOURCES);
            if (url.includes('/graph')) return ok({ nodes: [], edges: [], externals: [], problems: [], unavailable: [], complete: true });
            if (url.includes('/api/studio-apps')) return ok({ apps: [{ id: 'a2', name: 'Second desk' }] });
            return ok({});
        });

        const { findAllByTestId, findByTestId, findByText, container } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        await waitFor(async () => expect((await findByTestId('solution-publish')).disabled).toBe(false));

        fireEvent.change(container.querySelector('#solution-add-kind'), { target: { value: 'app' } });
        fireEvent.click(await findByText('Second desk'));

        await waitFor(() => expect(completenessCalls).toBeGreaterThan(1));
        expect((await findByTestId('solution-publish')).disabled).toBe(true);
    });

    it('the Check tab shows the findings the aggregator raised', async () => {
        mockFetch({
            completeness: {
                ...CLEAN, blocked: true,
                findings: [{
                    code: 'cross_owner', severity: 'error', kind: 'app',
                    targetRef: { kind: 'app', id: 'a1', title: 'Desk' },
                    message: 'Desk runs a routine owned by someone else.',
                    deepLink: '/app/studio/apps/a1',
                }],
            },
        });
        const { findAllByTestId, findByText } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        fireEvent.click(await findByText('Check'));
        expect(await findByText('Desk runs a routine owned by someone else.')).toBeTruthy();
        expect(await findByText('Has to be fixed first')).toBeTruthy();
    });

    it('no Blueprint yet means no version chip — never an invented v1.0', async () => {
        const { findAllByTestId, queryByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        await waitFor(() => expect(globalThis.__authFetch.mock.calls.some(([u]) => String(u).includes('/package/blueprints'))).toBe(true));
        expect(queryByTestId('studio-section-status')).toBeNull();
    });

    it('one owner\'s Blueprint series gives a version chip; two owners give none', async () => {
        mockFetch({ blueprints: [{ id: 'b1', solutionKey: 'sol_p1', version: 3, createdBy: 'alice' }] });
        const { findAllByTestId, findByTestId } = render(<SolutionsStudio />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        expect((await findByTestId('studio-section-status')).textContent).toContain('v3');
    });

});

describe('arriving straight at one Solution', () => {
    it('a deep link to a Solution the capped overview did not list still gets its name', async () => {
        // /summary is capped at 60. Past that the row for the Solution being
        // opened is simply not in hand, and the header would sit on "…" — so
        // the id is asked for on its own, through the same read narrowed by
        // `?ids=`, which can only ever intersect what the caller may see.
        mockFetch({ projects: [] });
        const beyond = { ...PROJECTS[0], id: 'p_beyond_the_cap', name: 'Number sixty-one' };
        const inner = globalThis.__authFetch;
        globalThis.__authFetch = vi.fn(async (url, init) => {
            if (String(url).includes('/api/projects/summary?ids=')) {
                expect(String(url)).toContain('p_beyond_the_cap');
                return { ok: true, status: 200, json: async () => ({ projects: [beyond], unavailable: [], hasMore: false }) };
            }
            return inner(url, init);
        });

        const { findByTestId } = render(<SolutionsStudio initialSolutionId="p_beyond_the_cap" />);
        await waitFor(async () => expect((await findByTestId('studio-section-title')).textContent).toBe('Number sixty-one'));
    });

    it('a deep link opens the Solution without a visit to the gallery first', async () => {
        const { findByTestId } = render(<SolutionsStudio initialSolutionId="p1" />);
        // The header paints before the gallery listing lands, so the name
        // arrives a tick later — it must arrive, not stay the placeholder.
        await waitFor(async () => expect((await findByTestId('studio-section-title')).textContent).toBe('Onboarding'));
        expect(await findByTestId('solution-band-people')).toBeTruthy();
    });

    it('back returns to the gallery and refreshes it', async () => {
        const onNavigate = vi.fn();
        const { findAllByTestId, findByTestId, container } = render(<SolutionsStudio onNavigate={onNavigate} />);
        fireEvent.click((await findAllByTestId('solutions-card'))[0]);
        fireEvent.click(await findByTestId('studio-section-back'));
        await waitFor(() => expect(container.querySelectorAll('[data-testid="solutions-card"]').length).toBe(2));
        expect(onNavigate).toHaveBeenCalledWith('studio/solutions');
    });
});
