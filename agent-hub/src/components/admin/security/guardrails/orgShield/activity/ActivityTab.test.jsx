/**
 * The Privacy Shield "What happened" tab.
 *
 * The load-bearing tests are the mount-safety ones: the monitoring endpoints
 * derive the organisation from the SESSION, so the tab must not exist on
 * mounts that can pin a different organisation (admin GuardrailsHub), and
 * `?tab=activity` there must fall back to Overview. Everything else pins the
 * overview-first behaviour: fetch only on activation, licence lock, one empty
 * card when idle, drill-down refetches with the right filter.
 *
 * Run: npx vitest run src/components/admin/guardrails/orgShield/activity/ActivityTab.test.jsx
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));

// Mirrors the real `t(key, fallbackOrParams?, params?)`, INCLUDING `{x}`
// interpolation. A mock that drops the params renders "Filter on {person}"
// for every row, so nothing on this pane can be told apart by name — and the
// filter labels are exactly how a keyboard or screen-reader user picks one.
vi.mock('../../../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({
        t: (key, fallbackOrParams, paramsArg) => {
            const hasStringFallback = typeof fallbackOrParams === 'string';
            const params = hasStringFallback ? paramsArg : fallbackOrParams;
            let out = hasStringFallback ? fallbackOrParams : key;
            if (params && typeof params === 'object') {
                for (const [k, v] of Object.entries(params)) {
                    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => String(v));
                }
            }
            return out;
        },
    }),
    __esModule: true,
}));

let licensed = true;
vi.mock('../../../../../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({
        tier: 'enterprise',
        hasFeature: (f) => (f === 'advanced_usage_monitoring' ? licensed : true),
        hasTier: () => true,
        upgradeUrl: null,
    }),
}));

import OrgShieldEditor from '../OrgShieldEditor';
import { authFetch } from '../../../../../../utils/helpers';

const ORG_ID = 'org-alpha';
const SHIELD = {
    enabled: true,
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
};

const GUARD_OVERVIEW = {
    summary: { total_events: 12, pii_count: 4, moderation_count: 6, regex_count: 2, unique_users: 3 },
    timeline: [
        { period: '2026-07-01', total: 5, moderation: 3, pii: 1, regex: 1 },
        { period: '2026-07-02', total: 7, moderation: 3, pii: 3, regex: 1 },
    ],
    top_categories: [{ category: 'Email', violation_type: 'pii', count: 4 }],
    // 7 replaced + 5 stopped = the 12 times the shield stepped in; the
    // configuration-audit row is not a message and must not count.
    by_action: [
        { action_taken: 'tokenized', violation_type: 'pii', count: 7 },
        { action_taken: 'blocked', violation_type: 'pii', count: 5 },
        { action_taken: 'changed the scope', violation_type: 'admin_action', count: 9 },
    ],
    top_users: [{ user_id: 'u-kim', display_name: 'Kim', total: 9 }],
    health: { last_event_at: '2026-07-02' },
};
const INTEG_OVERVIEW = {
    summary: {
        total_calls: 40, local_count: 10, eu_count: 24, non_eu_count: 6,
        pii_non_eu_count: 0, sovereignty_score: 88, score_delta: 2, pii_events: 3,
    },
    timeline: [],
    top: {
        destinations: [], integrations: [], actors: [], users: [],
        non_eu_destinations: [{ dest_host: 'api.openai.com', country_name: 'United States', total: 6, pii_events: 0 }],
    },
    pii_categories: [], data_categories: [],
    health: { last_event_at: null, scan_levels: { full: 1, basic: 0, none: 0 }, unknown_operator_pct: 0 },
};
const ZERO_GUARD = { ...GUARD_OVERVIEW, summary: { total_events: 0, pii_count: 0 }, timeline: [], top_users: [], top_categories: [] };
const ZERO_INTEG = { ...INTEG_OVERVIEW, summary: { total_calls: 0, sovereignty_score: null }, top: { ...INTEG_OVERVIEW.top, non_eu_destinations: [] } };

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const PATH = '/app/settings/organisation/privacy';

let guardOverview = GUARD_OVERVIEW;
let integOverview = INTEG_OVERVIEW;
/** Zero aggregates AND zero rows — the genuinely idle organisation. */
let emptyDetails = false;
/** How many guard rows the detail endpoint returns (for the cap test). */
let manyRows = 0;
/** Egress rows, when a test needs other ones than the single US call. */
let egressRows = null;
/** The id of the single shield event (the call's id is 7). */
let guardRowId = 1;

const usageCalls = () => authFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('/api/usage/'));

// Timestamps have to land INSIDE the window the tab derives, or the rows fall
// out of the trend's buckets and the counts read as zero.
const now = () => new Date().toISOString();

const guardRow = (i) => ({
    id: i, timestamp: now(), user_id: 'u-kim', display_name: 'Kim',
    source: 'direct_chat', violation_type: 'pii', violation_categories: 'Email',
    action_taken: 'redacted',
});

beforeEach(() => {
    window.history.replaceState({}, '', PATH);
    licensed = true;
    guardOverview = GUARD_OVERVIEW;
    integOverview = INTEG_OVERVIEW;
    emptyDetails = false;
    manyRows = 0;
    egressRows = null;
    guardRowId = 1;
    authFetch.mockReset();
    authFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
        if (u.includes('/ai/config/chat-models-eu')) return ok({});
        if (u.includes('/ai/config')) return ok({ searchProvider: 'serper' });
        if (u.includes('/api/usage/guardrails/overview')) return ok(guardOverview);
        if (u.includes('/api/usage/integrations/overview')) return ok(integOverview);
        if (u.includes('/api/usage/guardrails/recent')) {
            if (emptyDetails) return ok([]);
            if (manyRows) return ok(Array.from({ length: manyRows }, (_, i) => guardRow(i + 1)));
            return ok([guardRow(guardRowId)]);
        }
        if (u.includes('/api/usage/integrations/egress')) {
            if (emptyDetails) return ok([]);
            if (egressRows) return ok(egressRows);
            return ok([{
                id: 7, timestamp: now(), user_id: 'u-kim', display_name: 'Kim',
                source: 'direct_chat', integration_type: 'openai_images',
                dest_host: 'api.openai.com', country_name: 'United States', country_code: 'US',
                is_eu: false, is_local: false, status: 'success',
            }]);
        }
        if (u.includes('/api/org-privacy-shield/')) return ok(SHIELD);
        return ok({});
    });
});

const renderEditor = async (props = {}) => {
    render(<OrgShieldEditor orgId={ORG_ID} {...props} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Overview/ })).toBeInTheDocument());
};

describe('ActivityTab mount safety', () => {
    it('is offered ONLY with showActivityTab: the admin-hub mount keeps five tabs', async () => {
        await renderEditor();
        expect(screen.getAllByRole('tab')).toHaveLength(5);
        expect(screen.queryByRole('tab', { name: /What happened/ })).toBeNull();
    });

    it('shows six tabs on the org-settings mount', async () => {
        await renderEditor({ showActivityTab: true });
        expect(screen.getAllByRole('tab')).toHaveLength(6);
        expect(screen.getByRole('tab', { name: /What happened/ })).toBeEnabled();
    });

    it('?tab=activity falls back to Overview when the tab is not offered', async () => {
        window.history.replaceState({}, '', `${PATH}?tab=activity`);
        await renderEditor();
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
        expect(usageCalls()).toHaveLength(0);
    });

    it('?tab=activity opens the tab when it IS offered', async () => {
        window.history.replaceState({}, '', `${PATH}?tab=activity`);
        await renderEditor({ showActivityTab: true });
        expect(screen.getByRole('tab', { name: /What happened/ })).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(screen.getByText('Shield stepped in')).toBeInTheDocument());
    });
});

describe('ActivityTab behaviour', () => {
    it('fetches only the two 30-day aggregates until the tab is activated, and the rows after', async () => {
        await renderEditor({ showActivityTab: true });
        // The Overview, the strip and the checks judge settings against the
        // last 30 days, so the editor asks for the two AGGREGATES once — no
        // detail rows, no polling.
        await waitFor(() => expect(usageCalls().filter(u => u.includes('overview'))).toHaveLength(2));
        expect(usageCalls().some(u => u.includes('/recent') || u.includes('/egress'))).toBe(false);

        const user = userEvent.setup();
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await waitFor(() => expect(usageCalls().some(u => u.includes('/recent'))).toBe(true));
        // Two consolidated calls per consumer — not the 19 the old tabs fired.
        expect(usageCalls().filter(u => u.includes('overview'))).toHaveLength(4);
    });

    it('fetches nothing at all on a mount without the activity pane', async () => {
        await renderEditor({ showActivityTab: false });
        expect(usageCalls()).toHaveLength(0);
    });

    it('locked plan: friendly card, upgrade link, zero monitoring fetches', async () => {
        licensed = false;
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        expect(await screen.findByText('See what actually happened')).toBeInTheDocument();
        expect(usageCalls()).toHaveLength(0);
    });

    it('all-zero data collapses to ONE empty card — no KPIs, no sections', async () => {
        guardOverview = ZERO_GUARD;
        integOverview = ZERO_INTEG;
        emptyDetails = true;
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        expect(await screen.findByText(/Nothing to show yet/)).toBeInTheDocument();
        expect(screen.queryByText('Shield stepped in')).toBeNull();
        expect(screen.queryByText('Where it went')).toBeNull();
    });

    it('renders the KPIs from the SERVER aggregates while unfiltered', async () => {
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        expect(await screen.findByText('Shield stepped in')).toBeInTheDocument();

        // The share is the SERVER's location counts over the whole window,
        // not a recount of the ≤200-row sample (whose one call went to the
        // US): (10 own + 24 EEA) of the 40 placed calls.
        const euTile = screen.getByRole('button', { name: /Stayed in Europe/ });
        expect(euTile.textContent).toContain('85%');
        expect(euTile.textContent).toContain('10 own server · 24 EEA · 6 outside');

        // 7 replaced + 5 stopped came from by_action, not from the one row the
        // detail endpoint returned — and the audit row is not in it.
        const stepped = screen.getByRole('button', { name: /Shield stepped in/ });
        expect(stepped.textContent).toContain('12');
        expect(stepped.textContent).toContain('7 replaced · 5 stopped');
    });

    it('merges shield events and calls into one log, even when their ids collide', async () => {
        // Both ledgers number their rows with their own sequence. Shield event
        // 7 and call 7 are different things and both must show.
        guardRowId = 7;
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await screen.findByText('Log');
        expect(screen.getAllByRole('button', { name: 'Show the evidence for this row' })).toHaveLength(2);
        // The aggregates count 12 shield events and 40 calls, so the two rows
        // held are labelled as the latest ones, not as everything.
        expect(screen.getByText('2 of the latest 2 messages & calls')).toBeInTheDocument();

        // The outcome pill narrows the log to one kind of entry.
        await user.click(screen.getByRole('button', { name: /^No personal data/ }));
        expect(screen.getAllByRole('button', { name: 'Show the evidence for this row' })).toHaveLength(1);
        expect(within(screen.getByRole('region', { name: 'Log' })).getByText('api.openai.com')).toBeInTheDocument();
    });

    it('a finding shows its rows and says so while it does', async () => {
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        expect(await screen.findByText('3 tool calls carried personal data out unchanged')).toBeInTheDocument();

        const show = screen.getByRole('button', { name: 'Show these' });
        await user.click(show);
        expect(screen.getByRole('button', { name: 'Showing these' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: /Remove this filter/ }).textContent).toContain('Left with a tool, unchanged');
    });

    it('a top-person click filters every panel in place, without refetching', async () => {
        // The drill USED to refetch with `?user=`. The pane is now one
        // cross-filter over rows already held, so a click costs no round trip
        // — that is the point of fetching both detail sets up front — and the
        // filter shows as a removable chip.
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await screen.findByText('People');

        const before = usageCalls().length;
        await user.click(screen.getByRole('button', { name: /Filter on Kim/ }));

        // A chip appeared, and nothing was fetched to produce it.
        expect(await screen.findByRole('button', { name: /Remove this filter/ })).toBeInTheDocument();
        expect(usageCalls()).toHaveLength(before);
    });

    it('stacks filters across axes and clears them one at a time', async () => {
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await screen.findByText('People');

        await user.click(screen.getByRole('button', { name: /Filter on Kim/ }));
        await user.click(screen.getByRole('button', { name: /Filter on Direct chat/ }));
        expect(screen.getAllByRole('button', { name: /Remove this filter/ })).toHaveLength(2);

        await user.click(screen.getAllByRole('button', { name: /Remove this filter/ })[0]);
        expect(screen.getAllByRole('button', { name: /Remove this filter/ })).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: /Clear all/ }));
        expect(screen.queryByRole('button', { name: /Remove this filter/ })).toBeNull();
    });

    it('says so when a filtered figure is counted over a capped sample', async () => {
        // 900 events in the window, 200 fetchable. Every recounted number is a
        // floor, and presenting one as a total is the exact failure the
        // server-side aggregate exists to prevent.
        guardOverview = { ...GUARD_OVERVIEW, summary: { ...GUARD_OVERVIEW.summary, total_events: 900 } };
        manyRows = 200;
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await screen.findByText('People');

        expect(screen.queryByText(/treat them as "at least"/)).toBeNull();
        await user.click(screen.getByRole('button', { name: /Filter on Kim/ }));
        expect(await screen.findByText(/treat them as "at least"/)).toBeInTheDocument();
    });

    it('shield off: tab stays usable and says it is showing history', async () => {
        authFetch.mockImplementation(async (url) => {
            const u = String(url);
            if (u.includes('/auth/organizations')) return ok([{ id: ORG_ID, name: 'Alpha BV' }]);
            if (u.includes('/ai/config/chat-models-eu')) return ok({});
            if (u.includes('/ai/config')) return ok({});
            if (u.includes('/api/usage/guardrails/overview')) return ok(GUARD_OVERVIEW);
            if (u.includes('/api/usage/integrations/overview')) return ok(INTEG_OVERVIEW);
            if (u.includes('/api/org-privacy-shield/')) return ok({ ...SHIELD, enabled: false });
            return ok({});
        });
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        const activityTab = screen.getByRole('tab', { name: /What happened/ });
        expect(activityTab).toBeEnabled();
        expect(screen.getByRole('tab', { name: /What we look for/ })).toBeDisabled();
        await user.click(activityTab);
        expect(await screen.findByText(/You are looking at past activity/)).toBeInTheDocument();
    });

    it('keeps the pathname byte-identical when the Activity tab is clicked', async () => {
        const before = window.location.pathname;
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        expect(window.location.pathname).toBe(before);
        expect(window.location.search).toContain('tab=activity');
    });
});

describe('ActivityTab: where the data went', () => {
    const row = (id, over) => ({
        id, timestamp: now(), user_id: 'u-kim', display_name: 'Kim', source: 'direct_chat',
        integration_type: 'http_request', status: 'success', ...over,
    });

    beforeEach(() => {
        integOverview = {
            ...INTEG_OVERVIEW,
            summary: { ...INTEG_OVERVIEW.summary, via_network_count: 12, unknown_count: 3 },
            top: {
                ...INTEG_OVERVIEW.top,
                destinations: [
                    { dest_host: 'api.claimsbridge.ca', location_state: 'outside', city: 'Toronto', country_code: 'CA', country_name: 'Canada', operator: 'ClaimsBridge Inc.', total: 6, pii_events: 2 },
                    { dest_host: 'api.fireflies.ai', location_state: 'via_network', city: 'Amsterdam', lat: 52.31, lon: 4.76, edge_pop: 'AMS', network: 'Cloudflare', total: 12, pii_events: 0 },
                ],
            },
        };
        egressRows = [
            row(1, { dest_host: 'api.fireflies.ai', location_state: 'via_network', location_basis: 'edge_header', network: 'Cloudflare', edge_pop: 'AMS', city: 'Amsterdam', country_code: 'NL' }),
            row(2, { dest_host: 'api.claimsbridge.ca', location_state: 'outside', location_basis: 'socket', city: 'Toronto', country_code: 'CA', country_name: 'Canada' }),
            row(3, { dest_host: 'cloud.example.nl', location_state: 'local', is_local: true, country_code: 'NL' }),
            row(4, { dest_host: 'tool.example', location_state: 'unknown', location_basis: 'none' }),
        ];
    });

    const openTab = async () => {
        const user = userEvent.setup();
        await renderEditor({ showActivityTab: true });
        await user.click(screen.getByRole('tab', { name: /What happened/ }));
        await screen.findByText('Where it went');
        return user;
    };

    it('leaves calls it cannot place out of the share, and says how many', async () => {
        await openTab();
        // Through a global network (12) or with no known place (3): neither
        // inside nor outside Europe, so named rather than folded into a side.
        const tile = screen.getByRole('button', { name: /Stayed in Europe/ });
        expect(tile.textContent).toContain('85%');
        expect(tile.textContent).toContain('15 not placed');
        expect(screen.getByText('12 calls went through Cloudflare')).toBeInTheDocument();
        expect(screen.getByText('3 calls went to a server we couldn\'t place')).toBeInTheDocument();
    });

    it('lists the destinations with their place, and filters the table on a click', async () => {
        const user = await openTab();
        const canada = screen.getByRole('button', { name: 'Filter on api.claimsbridge.ca' });
        expect(canada.textContent).toContain('Toronto, Canada · ClaimsBridge Inc.');
        expect(screen.getByRole('button', { name: 'Filter on api.fireflies.ai' }).textContent)
            .toContain('Cloudflare edge, Amsterdam');

        await user.click(canada);
        expect(await screen.findByRole('button', { name: /Remove this filter/ })).toBeInTheDocument();
        expect(screen.getByText('Toronto, CA')).toBeInTheDocument();
        expect(screen.queryByText('via Cloudflare, AMS')).toBeNull();
    });

    it('names the location of every call in the log', async () => {
        await openTab();
        for (const place of ['via Cloudflare, AMS', 'Toronto, CA', 'Your server', 'Unknown']) {
            expect(screen.getByText(place)).toBeInTheDocument();
        }
    });
});
