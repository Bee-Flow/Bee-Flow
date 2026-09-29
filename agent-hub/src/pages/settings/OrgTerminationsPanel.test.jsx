import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the org Terminations panel (Settings → Usage &
 * Monitoring → Terminations).
 *
 * NOTE ON THE NAME: despite "terminations", this screen ends nothing. It is a
 * read-only report over AI sessions that stopped early (token cap, iteration
 * cap, error, client abort). There is no destructive action here and therefore
 * no confirmation step to pin — the pins below cover what it REQUESTS, what it
 * SHOWS, and which per-row identifiers it puts on screen.
 *
 * The kit (Card/MetricCard/MonitorHero/AlertBanner/EmptyInline), the
 * formatters and the SEMANTIC palette are the real ones — they are pure and
 * are part of what a reader sees. Only authFetch is mocked.
 *
 * No i18n mock: the global setup awaits ensureI18nDefaults(), so the real
 * hook's provider-less fallback resolves against the full EN catalogue.
 *
 * Nothing here judges the behaviour. Where today's behaviour is a wart the
 * test NAME says so.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import OrgTerminationsPanel from './OrgTerminationsPanel';
import { authFetch } from '../../utils/helpers';

const API = '/api/terminations/org';

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const ROW = {
    id: 'r1',
    timestamp: '2026-01-02T03:04:05Z',
    agent_id: 'ag-1',
    agent_name: 'Invoice Bot',
    model: 'anthropic/claude-opus-4-5-2026-02-01',
    termination_type: 'error',
    error_code: 'ETIMEDOUT',
    iteration_count: 4,
    duration_ms: 2400,
    total_tokens: 1500,
    prompt_tokens: 1200,
    completion_tokens: 300,
    attachment_count: 0,
    attachment_bytes: 0,
    source: 'chat',
    conversation_id: 'conv-abc',
    user_id: 'user-42',
    error_class: 'TimeoutError',
    error_first_line: 'upstream timed out',
    stack_first_line: 'at fetchUpstream (x.js:12)',
};

/** Route the four calls the panel fires. Any of them may be overridden. */
function serve({ summary, timeline, list, byAgent } = {}) {
    authFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/summary')) return summary ?? jsonRes({ total: 0, by_type: {} });
        if (u.includes('/timeline')) return timeline ?? jsonRes({ rows: [] });
        if (u.includes('/by-agent')) return byAgent ?? jsonRes({ rows: [] });
        return list ?? jsonRes({ rows: [] });
    });
}

const urls = () => authFetch.mock.calls.map(c => String(c[0]));
const urlFor = (fragment) => urls().filter(u => u.includes(fragment));

/** Mount and wait for the loading card to disappear. */
async function mount(opts, props = {}) {
    serve(opts);
    const view = render(<OrgTerminationsPanel {...props} />);
    await waitFor(() => expect(screen.queryByText('Loading terminations…')).toBeNull());
    return view;
}

/** The Card whose header carries `title`. */
const cardFor = (title) => screen.getByText(title).closest('div[style]').parentElement.parentElement;

/** The hero's grid, so KPI tiles can be read without hitting the filter bar. */
const heroGrid = () => screen.getByText('Clean completion rate').closest('div[style]').parentElement.parentElement;

/** Value of one small KPI tile in the hero aside. */
const kpi = (label) => within(heroGrid()).getByText(label).nextElementSibling.textContent;

/**
 * The clickable detail row carrying `text`. An agent name can occur three
 * times on this screen (detail row, by-agent card, agent <option>); the detail
 * row is the only <span> whose parent is `cursor: pointer` — the <select> is
 * cursor:pointer too, hence the tag check.
 */
const detailRowFor = (text) => screen
    .queryAllByText(text)
    .find(el => el.tagName === 'SPAN' && el.parentElement?.style?.cursor === 'pointer')
    ?.parentElement;

const detailCells = (text) => Array.from(detailRowFor(text).children).map(c => c.textContent);
const openRow = (text) => fireEvent.click(detailRowFor(text));

beforeEach(() => { cleanup(); vi.clearAllMocks(); });

describe('OrgTerminationsPanel — first paint and the four requests', () => {
    it('shows the header and the loading card until the first responses land', async () => {
        authFetch.mockImplementation(() => new Promise(() => {}));
        render(<OrgTerminationsPanel />);
        expect(screen.getByRole('heading', { name: 'Terminations' })).toBeInTheDocument();
        expect(screen.getByText('Tasks that ended early — token limits, errors, or aborts')).toBeInTheDocument();
        expect(screen.getByText('Loading terminations…')).toBeInTheDocument();
        // Nothing below the header is rendered yet.
        expect(screen.queryByText('Clean completion rate')).toBeNull();
    });

    it('fires exactly four requests, and with no rangeParams sends no date filter', async () => {
        await mount();
        expect(authFetch).toHaveBeenCalledTimes(4);
        expect(urls()).toEqual([
            `${API}/summary`,
            `${API}/timeline?interval=day`,
            `${API}?limit=200`,
            `${API}/by-agent`,
        ]);
    });

    it('appends ?days=N to all four when rangeParams carries days', async () => {
        await mount({}, { rangeParams: { days: 7 } });
        expect(urls()).toEqual([
            `${API}/summary?days=7`,
            `${API}/timeline?days=7&interval=day`,
            `${API}?days=7&limit=200`,
            `${API}/by-agent?days=7`,
        ]);
    });

    it('sends days=0 rather than dropping the filter (days is compared against null, not falsiness)', async () => {
        await mount({}, { rangeParams: { days: 0 } });
        expect(urlFor('/summary')).toEqual([`${API}/summary?days=0`]);
    });

    it('prefers an explicit start/end window over days, and carries the interval only on /timeline', async () => {
        await mount({}, { rangeParams: { days: 30, startDate: '2026-01-01', endDate: '2026-02-01', interval: 'week' } });
        expect(urls()).toEqual([
            `${API}/summary?startDate=2026-01-01&endDate=2026-02-01`,
            `${API}/timeline?startDate=2026-01-01&endDate=2026-02-01&interval=week`,
            `${API}?startDate=2026-01-01&endDate=2026-02-01&limit=200`,
            `${API}/by-agent?startDate=2026-01-01&endDate=2026-02-01`,
        ]);
    });

    it('sends the literal string "undefined" as endDate when only startDate is given (wart)', async () => {
        await mount({}, { rangeParams: { startDate: '2026-01-01' } });
        expect(urlFor('/summary')).toEqual([`${API}/summary?startDate=2026-01-01&endDate=undefined`]);
    });

    it('re-fetches all four when the rangeParams OBJECT identity changes, even with identical values (wart)', async () => {
        serve();
        const { rerender } = render(<OrgTerminationsPanel rangeParams={{ days: 7 }} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(4));
        rerender(<OrgTerminationsPanel rangeParams={{ days: 7 }} />);
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(8));
    });

    it('re-fetches all four when the refresh button is pressed', async () => {
        await mount();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(8));
    });

    it('keeps the table on screen during a refresh — the loading card only covers a cold start', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        expect(detailRowFor('Invoice Bot')).toBeTruthy();
        let release;
        authFetch.mockImplementation(() => new Promise(res => { release = res; }));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(screen.queryByText('Loading terminations…')).toBeNull();
        expect(detailRowFor('Invoice Bot')).toBeTruthy();
        release(jsonRes({ rows: [] }));
    });
});

describe('OrgTerminationsPanel — the health hero', () => {
    it('reports 100% / Healthy in green when nothing failed', async () => {
        await mount({ summary: jsonRes({ total: 40, by_type: { max_tokens: 40 } }) });
        expect(screen.getByText('Clean completion rate')).toBeInTheDocument();
        expect(screen.getByText('100%')).toHaveStyle({ color: 'rgb(16, 185, 129)' });
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.getByText('40 sessions terminated · 0 errors (0%)')).toBeInTheDocument();
    });

    it('still reports Healthy at exactly 95% clean', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 5 } }) });
        expect(screen.getByText('95%')).toHaveStyle({ color: 'rgb(16, 185, 129)' });
        expect(screen.getByText('Healthy')).toBeInTheDocument();
    });

    it('reports Watch in amber between 80% and 95% clean', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 10 } }) });
        expect(screen.getByText('90%')).toHaveStyle({ color: 'rgb(245, 158, 11)' });
        expect(screen.getByText('Watch')).toBeInTheDocument();
    });

    it('reports Failing in red below 80% clean', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 40 } }) });
        expect(screen.getByText('60%')).toHaveStyle({ color: 'rgb(239, 68, 68)' });
        expect(screen.getByText('Failing')).toBeInTheDocument();
    });

    it('singularises the subline for exactly one session and one error', async () => {
        await mount({ summary: jsonRes({ total: 1, by_type: { error: 1 } }) });
        expect(screen.getByText('1 session terminated · 1 error (100%)')).toBeInTheDocument();
    });

    it('shows an em dash and "No data" when the summary is empty', async () => {
        await mount({ summary: jsonRes({ total: 0, by_type: {} }) });
        expect(screen.getByText('—')).toBeInTheDocument();
        expect(screen.getByText('No data')).toBeInTheDocument();
        expect(screen.getByText('0 sessions terminated · 0 errors (0%)')).toBeInTheDocument();
    });

    it('renders the four KPI tiles from summary.by_type, defaulting missing buckets to 0', async () => {
        await mount({ summary: jsonRes({ total: 12, by_type: { max_tokens: 5, error: 2 } }) });
        expect(kpi('Max tokens')).toBe('5');
        expect(kpi('Max iterations')).toBe('0');
        expect(kpi('Errors')).toBe('2');
        expect(kpi('Aborted')).toBe('0');
    });

    it('compacts big KPI counts to 1.2K / 3.4M', async () => {
        await mount({ summary: jsonRes({ total: 3_400_000, by_type: { max_tokens: 1234, error: 3_400_000 } }) });
        expect(kpi('Max tokens')).toBe('1.2K');
        expect(kpi('Errors')).toBe('3.4M');
    });
});

describe('OrgTerminationsPanel — the error alert banner', () => {
    const banner = () => screen.queryByText(/terminated by error/);

    it('stays hidden below the 10-session minimum sample, however bad the ratio', async () => {
        await mount({ summary: jsonRes({ total: 9, by_type: { error: 9 } }) });
        expect(banner()).toBeNull();
    });

    it('stays hidden at exactly 5% errors (the threshold is strictly greater-than)', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 5 } }) });
        expect(banner()).toBeNull();
    });

    it('appears above 5% with the count, the percentage and a fixed advice line', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 6 } }) });
        expect(screen.getByText('6 sessions terminated by error (6% of total) — investigate failing integrations.')).toBeInTheDocument();
        expect(screen.getByText('Action required')).toBeInTheDocument();
    });

    it('stays amber up to four times the threshold, and turns red above it', async () => {
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 20 } }) });
        expect(screen.getByText('Action required')).toHaveStyle({ color: 'rgb(245, 158, 11)' });
        cleanup();
        await mount({ summary: jsonRes({ total: 100, by_type: { error: 21 } }) });
        expect(screen.getByText('Action required')).toHaveStyle({ color: 'rgb(239, 68, 68)' });
    });

    it('singularises a lone error in the banner message', async () => {
        await mount({ summary: jsonRes({ total: 10, by_type: { error: 1 } }) });
        expect(screen.getByText('1 session terminated by error (10% of total) — investigate failing integrations.')).toBeInTheDocument();
    });

    it('the "Review errors" CTA filters the detail table down to error rows', async () => {
        await mount({
            summary: jsonRes({ total: 100, by_type: { error: 30 } }),
            list: jsonRes({ rows: [ROW, { ...ROW, id: 'r2', termination_type: 'aborted', agent_name: 'Aborted Bot' }] }),
        });
        expect(detailRowFor('Aborted Bot')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Review errors/ }));
        await waitFor(() => expect(detailRowFor('Aborted Bot')).toBeUndefined());
        expect(detailRowFor('Invoice Bot')).toBeTruthy();
        expect(screen.getByText('1 event')).toBeInTheDocument();
    });

    it('leaves the filtered-out agent in the agent dropdown — the options come from the unfiltered rows (wart)', async () => {
        const { container } = await mount({
            summary: jsonRes({ total: 100, by_type: { error: 30 } }),
            list: jsonRes({ rows: [ROW, { ...ROW, id: 'r2', agent_id: 'ag-2', termination_type: 'aborted', agent_name: 'Aborted Bot' }] }),
        });
        fireEvent.click(screen.getByRole('button', { name: /Review errors/ }));
        await waitFor(() => expect(detailRowFor('Aborted Bot')).toBeUndefined());
        expect(Array.from(container.querySelectorAll('select')[1].options).map(o => o.textContent))
            .toEqual(['All agents', 'Invoice Bot', 'Aborted Bot']);
    });
});

describe('OrgTerminationsPanel — a failed load', () => {
    it('throws away the BODY of a non-ok response and renders it exactly like an empty range — no error is surfaced (wart)', async () => {
        // Every response carries usable data; only the status says no. Nothing
        // of it reaches the screen, and nothing says why.
        await mount({
            summary: jsonRes({ total: 99, by_type: { error: 99 } }, 403),
            timeline: jsonRes({ rows: [{ period: '2026-01-01', termination_type: 'error', count: 4 }] }, 403),
            list: jsonRes({ rows: [ROW] }, 403),
            byAgent: jsonRes({ rows: [{ agent_id: 'ag-1', agent_name: 'Invoice Bot', total: 3 }] }, 403),
        });
        expect(screen.queryByText('By agent')).toBeNull();
        expect(detailRowFor('Invoice Bot')).toBeUndefined();
        expect(screen.getByText('No data')).toBeInTheDocument();
        expect(screen.getByText('0 sessions terminated · 0 errors (0%)')).toBeInTheDocument();
        expect(screen.getByText('No data to display')).toBeInTheDocument();
        expect(screen.getByText('No terminations match the filters')).toBeInTheDocument();
        expect(screen.queryByText(/could not|failed to load|forbidden/i)).toBeNull();
    });

    it('treats an unparseable body as empty per response — the other three still land', async () => {
        // The json() throw is caught per response, so only the list is lost;
        // without that per-response catch the whole Promise.all would reject
        // and NOTHING (hero included) would be set.
        await mount({
            summary: jsonRes({ total: 40, by_type: { max_tokens: 40 } }),
            list: { ok: true, status: 200, json: async () => { throw new Error('bad json'); } },
        });
        expect(screen.getByText('No terminations match the filters')).toBeInTheDocument();
        expect(screen.getByText('100%')).toBeInTheDocument();
        expect(screen.getByText('40 sessions terminated · 0 errors (0%)')).toBeInTheDocument();
    });

    it('keeps the PREVIOUS data on screen when a refresh throws, with no staleness marker (wart)', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }), summary: jsonRes({ total: 100, by_type: { error: 0 } }) });
        expect(detailRowFor('Invoice Bot')).toBeTruthy();

        authFetch.mockRejectedValue(new Error('offline'));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(8));

        expect(detailRowFor('Invoice Bot')).toBeTruthy();
        expect(screen.getByText('100%')).toBeInTheDocument();
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.queryByText(/offline|error loading|stale/i)).toBeNull();
    });
});

describe('OrgTerminationsPanel — timeline and by-agent', () => {
    it('shows the four-type legend above the chart', async () => {
        await mount({ timeline: jsonRes({ rows: [{ period: '2026-01-01', termination_type: 'error', count: 2 }] }) });
        const card = cardFor('Terminations over time');
        ['Max tokens', 'Max iterations', 'Error', 'Aborted'].forEach(label => {
            expect(within(card).getAllByText(label).length).toBeGreaterThan(0);
        });
    });

    it('labels each bar with the period minus its first five characters (YYYY- is dropped)', async () => {
        await mount({
            timeline: jsonRes({
                rows: [
                    { period: '2026-01-01', termination_type: 'error', count: 2 },
                    { period: '2026-01-02', termination_type: 'aborted', count: 1 },
                ],
            }),
        });
        expect(screen.getByText('01-01')).toBeInTheDocument();
        expect(screen.getByText('01-02')).toBeInTheDocument();
    });

    it('titles each bar with "period · total", summing every type in that bucket', async () => {
        const { container } = await mount({
            timeline: jsonRes({
                rows: [
                    { period: '2026-01-01', termination_type: 'error', count: 2 },
                    { period: '2026-01-01', termination_type: 'aborted', count: 3 },
                ],
            }),
        });
        expect(container.querySelector('[title="2026-01-01 · 5"]')).not.toBeNull();
    });

    it('shows "No data to display" when the timeline is empty', async () => {
        await mount({ timeline: jsonRes({ rows: [] }) });
        expect(screen.getByText('No data to display')).toBeInTheDocument();
    });

    it('hides the by-agent card entirely when the endpoint returns nothing', async () => {
        await mount({ byAgent: jsonRes({ rows: [] }) });
        expect(screen.queryByText('By agent')).toBeNull();
    });

    it('renders one by-agent row per agent with its five counters, zero-filling missing ones', async () => {
        await mount({
            byAgent: jsonRes({ rows: [{ agent_id: 'ag-1', agent_name: 'Invoice Bot', total: 9, max_tokens: 4, errors: 5 }] }),
        });
        const card = cardFor('By agent');
        const row = within(card).getByText('Invoice Bot').parentElement;
        expect(Array.from(row.children).map(c => c.textContent)).toEqual(['Invoice Bot', '9', '4', '0', '5', '0']);
    });

    it('falls back to the agent id, then to an em dash, when the name is missing', async () => {
        await mount({
            byAgent: jsonRes({ rows: [{ agent_id: 'ag-9', total: 1 }, { total: 2 }] }),
        });
        const card = cardFor('By agent');
        expect(within(card).getByText('ag-9')).toBeInTheDocument();
        expect(within(card).getByText('—')).toBeInTheDocument();
    });
});

describe('OrgTerminationsPanel — the detail table', () => {
    const twoRows = {
        rows: [
            ROW,
            {
                ...ROW, id: 'r2', agent_id: 'ag-2', agent_name: 'Report Bot',
                termination_type: 'max_tokens', error_code: null, model: 'openai/gpt-5',
            },
        ],
    };

    it('renders one row per record with time, agent, short model, badge, error code, iterations, duration and tokens', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        expect(detailCells('Invoice Bot')).toEqual([
            new Date(ROW.timestamp).toLocaleDateString(),
            'Invoice Bot',
            'claude-opus-4-5',
            'Error',
            'ETIMEDOUT',
            '4',
            '2.4 s',
            '1.5K',
            '▸',
        ]);
    });

    it('shows an em dash for a missing error code', async () => {
        await mount({ list: jsonRes(twoRows) });
        expect(detailCells('Report Bot')[4]).toBe('—');
    });

    it('counts the visible events, singular at one', async () => {
        await mount({ list: jsonRes(twoRows) });
        expect(screen.getByText('2 events')).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText('Search agent / model / error...'), { target: { value: 'Report' } });
        expect(await screen.findByText('1 event')).toBeInTheDocument();
    });

    it('searches agent name, model and error code — case-insensitively', async () => {
        await mount({ list: jsonRes(twoRows) });
        const box = screen.getByPlaceholderText('Search agent / model / error...');
        fireEvent.change(box, { target: { value: 'etimedout' } });
        expect(detailRowFor('Invoice Bot')).toBeTruthy();
        expect(detailRowFor('Report Bot')).toBeUndefined();
        fireEvent.change(box, { target: { value: 'gpt-5' } });
        expect(detailRowFor('Report Bot')).toBeTruthy();
        expect(detailRowFor('Invoice Bot')).toBeUndefined();
    });

    it('does NOT search the user id or conversation id', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        fireEvent.change(screen.getByPlaceholderText('Search agent / model / error...'), { target: { value: 'user-42' } });
        expect(detailRowFor('Invoice Bot')).toBeUndefined();
        expect(screen.getByText('No terminations match the filters')).toBeInTheDocument();
    });

    it('filters by termination type, with the four fixed options plus "All types"', async () => {
        const { container } = await mount({ list: jsonRes(twoRows) });
        const select = container.querySelectorAll('select')[0];
        expect(Array.from(select.options).map(o => o.textContent)).toEqual([
            'All types', 'Max tokens', 'Max iterations', 'Error', 'Aborted',
        ]);
        fireEvent.change(select, { target: { value: 'max_tokens' } });
        expect(detailRowFor('Report Bot')).toBeTruthy();
        expect(detailRowFor('Invoice Bot')).toBeUndefined();
    });

    it('builds the agent filter from the rows themselves, first name seen wins', async () => {
        const { container } = await mount({ list: jsonRes(twoRows) });
        const select = container.querySelectorAll('select')[1];
        expect(Array.from(select.options).map(o => o.textContent)).toEqual(['All agents', 'Invoice Bot', 'Report Bot']);
        fireEvent.change(select, { target: { value: 'ag-2' } });
        expect(detailRowFor('Report Bot')).toBeTruthy();
        expect(detailRowFor('Invoice Bot')).toBeUndefined();
    });

    it('labels an agent option by its id when the row carries no name', async () => {
        const { container } = await mount({ list: jsonRes({ rows: [{ ...ROW, agent_name: null }] }) });
        expect(Array.from(container.querySelectorAll('select')[1].options).map(o => o.textContent))
            .toEqual(['All agents', 'ag-1']);
    });

    it('says "No terminations match the filters" even when there are no rows at all and no filter is set (wart)', async () => {
        await mount({ list: jsonRes({ rows: [] }) });
        expect(screen.getByText('No terminations match the filters')).toBeInTheDocument();
    });
});

describe('OrgTerminationsPanel — the expanded row', () => {
    it('opens on click and puts the raw user id and conversation id on screen, under a "not logged" privacy note', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        expect(screen.queryByText('user-42')).toBeNull();
        openRow('Invoice Bot');

        expect(screen.getByText('user-42')).toBeInTheDocument();
        expect(screen.getByText('conv-abc')).toBeInTheDocument();
        expect(screen.getByText('chat')).toBeInTheDocument();
        expect(screen.getByText('TimeoutError')).toBeInTheDocument();
        expect(screen.getByText('upstream timed out')).toBeInTheDocument();
        expect(screen.getByText('at fetchUpstream (x.js:12)')).toBeInTheDocument();
        expect(screen.getByText('Privacy: messages are not logged. Only sanitised metadata is shown here.')).toBeInTheDocument();
    });

    it('spells out the prompt/completion split with a prompt share', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        openRow('Invoice Bot');
        expect(screen.getByText('prompt 1.2K · completion 300 · total 1.5K (prompt 80%)')).toBeInTheDocument();
    });

    it('falls back to an em dash for every missing detail field', async () => {
        await mount({ list: jsonRes({ rows: [{ id: 'bare', termination_type: 'aborted' }] }) });
        fireEvent.click(screen.getByText('▸'));
        // source, conversation, user, error class, error, stack, attachments = 7 dashes,
        // plus the model cell ("Unknown") and error-code cell in the collapsed row.
        expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(7);
    });

    it('closes again on a second click', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        openRow('Invoice Bot');
        expect(screen.getByText('user-42')).toBeInTheDocument();
        openRow('Invoice Bot');
        expect(screen.queryByText('user-42')).toBeNull();
    });

    it('opens only one row at a time', async () => {
        await mount({ list: jsonRes({ rows: [ROW, { ...ROW, id: 'r2', agent_name: 'Report Bot', user_id: 'user-99' }] }) });
        openRow('Invoice Bot');
        expect(screen.getByText('user-42')).toBeInTheDocument();
        openRow('Report Bot');
        expect(screen.getByText('user-99')).toBeInTheDocument();
        expect(screen.queryByText('user-42')).toBeNull();
    });

    it('expands EVERY row at once when the rows carry no id (wart)', async () => {
        await mount({
            list: jsonRes({
                rows: [
                    { termination_type: 'error', agent_name: 'A', user_id: 'user-a' },
                    { termination_type: 'error', agent_name: 'B', user_id: 'user-b' },
                ],
            }),
        });
        openRow('A');
        expect(screen.getByText('user-a')).toBeInTheDocument();
        expect(screen.getByText('user-b')).toBeInTheDocument();
        expect(screen.getAllByText('Privacy: messages are not logged. Only sanitised metadata is shown here.')).toHaveLength(2);
    });
});

describe('OrgTerminationsPanel — unknown termination types', () => {
    const WEIRD = { ...ROW, id: 'w1', termination_type: 'quota_exceeded' };

    it('renders the RAW i18n key in the badge, because the `|| type` fallback can never fire (wart)', async () => {
        await mount({ list: jsonRes({ rows: [WEIRD] }) });
        expect(screen.getByText('org.terminations_type_quota_exceeded')).toBeInTheDocument();
        expect(screen.queryByText('quota_exceeded')).toBeNull();
    });

    it('leaves an unknown type out of the type filter — its options are the fixed TYPE_ORDER, not the rows', async () => {
        const { container } = await mount({ list: jsonRes({ rows: [WEIRD] }) });
        expect(Array.from(container.querySelectorAll('select')[0].options).map(o => o.value))
            .toEqual(['', 'max_tokens', 'max_iterations', 'error', 'aborted']);
    });

    it('drops an unknown type out of the stacked chart while still sizing the bar by the bucket total', async () => {
        const { container } = await mount({
            timeline: jsonRes({ rows: [{ period: '2026-01-01', termination_type: 'quota_exceeded', count: 7 }] }),
        });
        // The bucket is titled with its real total, but no coloured segment is drawn.
        expect(container.querySelector('[title="2026-01-01 · 0"]')).not.toBeNull();
        expect(screen.getByText('01-01')).toBeInTheDocument();
    });
});

describe('OrgTerminationsPanel — the large-input badge and the showTokens split', () => {
    const BIG_PROMPT = { ...ROW, id: 'big', prompt_tokens: 9000, completion_tokens: 100, total_tokens: 9100 };
    const BIG_ATTACH = { ...ROW, id: 'att', attachment_count: 2, attachment_bytes: 300 * 1024 };

    it('shows the large-input KPI tile and the in-row badge when the prompt is huge', async () => {
        await mount({ list: jsonRes({ rows: [BIG_PROMPT] }) });
        expect(screen.getByText('Likely caused by big prompt / attachment')).toBeInTheDocument();
        expect(screen.getAllByText('Large input').length).toBeGreaterThanOrEqual(2);
    });

    it('hides the large-input KPI tile entirely when nothing qualifies', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        expect(screen.queryByText('Likely caused by big prompt / attachment')).toBeNull();
        expect(screen.queryByText('Large input')).toBeNull();
    });

    it('explains the large input inside the expanded row', async () => {
        await mount({ list: jsonRes({ rows: [BIG_PROMPT] }) });
        openRow('Invoice Bot');
        expect(screen.getByText('Likely caused by large input.')).toBeInTheDocument();
        expect(screen.getByText('Suggest a smaller context or split the upload.')).toBeInTheDocument();
    });

    it('with showTokens=false drops the Tokens column, the token detail line and the token-driven badge', async () => {
        await mount({ list: jsonRes({ rows: [BIG_PROMPT] }) }, { showTokens: false });
        expect(screen.queryByText('Tokens')).toBeNull();
        expect(screen.queryByText('Large input')).toBeNull();
        openRow('Invoice Bot');
        // fNum(9000) renders as "9.0K" — /prompt 9K/ could never match.
        expect(screen.queryByText(/prompt 9\.0K/)).toBeNull();
        expect(screen.getByText('user-42')).toBeInTheDocument();
    });

    it('with showTokens=false the badge still fires on a large ATTACHMENT', async () => {
        await mount({ list: jsonRes({ rows: [BIG_ATTACH] }) }, { showTokens: false });
        expect(screen.getAllByText('Large input').length).toBeGreaterThanOrEqual(2);
        openRow('Invoice Bot');
        expect(screen.getByText('2 · 300.0 KB')).toBeInTheDocument();
    });

    it('keeps the Tokens column by default (showTokens is opt-out, not opt-in)', async () => {
        await mount({ list: jsonRes({ rows: [ROW] }) });
        expect(screen.getAllByText('Tokens').length).toBeGreaterThanOrEqual(1);
    });
});
