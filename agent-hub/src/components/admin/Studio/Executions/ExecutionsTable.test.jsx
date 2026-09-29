import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExecutionsTable from './ExecutionsTable';

/**
 * The runs list — specifically its Outcome column, which is the status table's
 * loudest surface: one word per row, a hundred rows down the page.
 *
 * The filter bar and the three data hooks are stubbed. This is not a test of
 * fetching or streaming (useExecutions has its own); it is a test that the row
 * says the right word in the right colour, and that the row's two opinions
 * about "running" — the pulsing dot and the status icon — are one opinion.
 */

const rows = vi.hoisted(() => ({ current: [] }));
const apiMock = vi.hoisted(() => ({}));
// What the HOOK reports the list actually fetched — the value the table obeys
// (it has already been through effectiveRunScope). 'mine' unless a test says
// otherwise, which is the shape every pre-existing test here assumes.
const hookRunScope = vi.hoisted(() => ({ current: 'mine' }));
const streamCalls = vi.hoisted(() => ({ current: [] }));

vi.mock('./useExecutions', () => ({
    default: () => ({
        rows: rows.current,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: false,
        loadMore: vi.fn(),
        refresh: vi.fn(),
        filters: {},
        setFilters: vi.fn(),
        facets: {},
        applyEvent: vi.fn(),
        patchRow: vi.fn(),
        scopedAutomationId: null,
        runScope: hookRunScope.current,
    }),
}));
vi.mock('./useRunStream', () => ({
    default: (opts) => { streamCalls.current.push(opts); return { state: opts?.enabled ? 'open' : 'paused' }; },
}));
vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiMock }));
// Records its props: the automation picker's OPTIONS are the surface one of
// the tests below is about, and they are not otherwise visible from the DOM.
const filterBarProps = vi.hoisted(() => ({ current: [] }));
vi.mock('./ExecutionsFilterBar', () => ({
    default: (props) => { filterBarProps.current.push(props); return <div data-testid="filter-bar" />; },
}));

const run = (over = {}) => ({
    id: 'r1',
    automationId: 'a1',
    automationTitle: 'Weekly digest',
    status: 'success',
    mode: 'live',
    startedAt: new Date().toISOString(),
    durationMs: 1200,
    triggerKind: 'schedule',
    ...over,
});

function renderTable(list, props = {}) {
    rows.current = list;
    return render(<ExecutionsTable scope="global" onOpenRun={vi.fn()} onOpenEditor={vi.fn()} {...props} />);
}

describe('ExecutionsTable — the Outcome column', () => {
    beforeEach(cleanup);

    it('prints the status word from the dictionary', () => {
        renderTable([run({ status: 'success' })]);
        expect(screen.getAllByText('Finished').length).toBeGreaterThan(0);
    });

    it('says "Running", not the raw status, and marks it as running once', () => {
        // The pulsing dot used to carry its own hard-coded bg-amber-500 — a
        // second opinion about the colour of "running" that stayed behind
        // when the table moved on.
        const { container } = renderTable([run({ status: 'running' })]);
        expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
        expect(container.innerHTML).not.toContain('bg-amber-500');
        expect(container.querySelector('[data-status-key]').getAttribute('data-status-key'))
            .toBe('run_status.running');
    });

    it('separates a paused run from a running one', () => {
        renderTable([run({ id: 'r1', status: 'running' }), run({ id: 'r2', status: 'paused' })]);
        expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
        const [running, paused] = [...document.querySelectorAll('[data-status-key]')];
        expect(running.getAttribute('data-status-key')).toBe('run_status.running');
        expect(paused.getAttribute('data-status-key')).toBe('run_status.paused');
    });

    it('says the status word in the "What happened" cell too, translated', () => {
        // The cell used to read routines.runs.status_plain ("{status}") and
        // interpolate the untranslated English word into it.
        renderTable([run({ status: 'handled_error' })]);
        expect(screen.getAllByText('Recovered').length).toBeGreaterThanOrEqual(2);
    });
});

describe('ExecutionsTable: the "What happened" cell', () => {
    beforeEach(cleanup);

    it('shows the builder\'s sentence for a failure, never the raw server message', () => {
        const raw = '550 5.1.1 <finance-team@example.com>: Recipient address rejected';
        renderTable([run({
            status: 'error',
            error: raw,
            outcome: { code: 'stopped_at', params: { step: 'Post to finance', reasonCode: 'validation', reason: 'a setting has a value this step cannot use' } },
        })]);
        const plain = 'Stopped at "Post to finance": a setting has a value this step cannot use';
        const cells = screen.getAllByText(plain);
        expect(cells.length).toBeGreaterThan(0);
        expect(screen.queryByText(raw)).toBeNull();
        // The raw message is in the hover, marked as such.
        expect(cells[0].getAttribute('title')).toContain(`Technical message: ${raw}`);
    });

    it('names a waiting run by who it waits for', () => {
        renderTable([run({ status: 'awaiting_approval', outcome: { code: 'waiting_approval', params: { who: 'S. de Boer' } } })]);
        expect(screen.getAllByText('Waiting for approval from S. de Boer').length).toBeGreaterThan(0);
    });
});

// ── the two approval gates, as the LIST answers them ────────────────────────
describe('ExecutionsTable — the ⋯ menu on a waiting run', () => {
    beforeEach(() => {
        cleanup();
        apiMock.approveRun = vi.fn().mockResolvedValue({});
        apiMock.approveStep = vi.fn().mockResolvedValue({});
        apiMock.retryRun = vi.fn().mockResolvedValue({});
        apiMock.cancelRun = vi.fn().mockResolvedValue({});
    });

    const openMenu = () => fireEvent.click(screen.getByTitle('Actions'));

    it('approves a RUN-level first-run confirm with the decision word', async () => {
        renderTable([run({ status: 'awaiting_confirm' })]);
        openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
        await waitFor(() => expect(apiMock.approveRun).toHaveBeenCalledWith('r1', 'approve'));
        expect(apiMock.approveStep).not.toHaveBeenCalled();
    });

    it('rejects a RUN-level first-run confirm right here — the same one click the run view offers', async () => {
        // The list and the run view must agree about what Reject does. When
        // they disagreed, the run view's Reject approved.
        renderTable([run({ status: 'awaiting_confirm' })]);
        openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
        await waitFor(() => expect(apiMock.approveRun).toHaveBeenCalledWith('r1', 'reject'));
        expect(apiMock.approveStep).not.toHaveBeenCalled();
    });

    it('addresses the LIVE leg of the journey, not the row that handed off', async () => {
        renderTable([run({ status: 'awaiting_confirm', journeyRunId: 'r9' })]);
        openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
        await waitFor(() => expect(apiMock.approveRun).toHaveBeenCalledWith('r9', 'reject'));
    });

    it('keeps a STEP-level rejection out of the list — it needs a reason, so it opens the run', () => {
        renderTable([run({ status: 'awaiting_approval' })]);
        openMenu();
        expect(screen.getByRole('button', { name: 'Review & decide' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    });
});

describe('ExecutionsTable — the organisation scope (Track H2)', () => {
    beforeEach(() => {
        cleanup();
        hookRunScope.current = 'mine';
        streamCalls.current = [];
    });

    it('opens every row in the personal scope', () => {
        const onOpenRun = vi.fn();
        renderTable([run({ id: 'r1' })], { onOpenRun });
        const row = screen.getByTestId('execution-row');
        expect(row.getAttribute('data-can-open')).toBe('true');
        fireEvent.click(row);
        expect(onOpenRun).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('execution-row-actions')).toBeTruthy();
    });

    it('in the org scope a colleague\'s row is shown, not opened — and has no ⋯ menu', () => {
        // Every per-run route (open, retry, stop, approve) is scoped to the
        // run's OWNER and 403s for anybody else, org admin included. A row
        // that invites a click it cannot honour is a dead end with an error
        // in it.
        hookRunScope.current = 'org';
        const onOpenRun = vi.fn();
        renderTable([run({ id: 'r1', mine: false })], { runScope: 'org', onOpenRun });
        const row = screen.getByTestId('execution-row');
        expect(row.getAttribute('data-can-open')).toBe('false');
        expect(row.getAttribute('role')).toBeNull();
        expect(row.getAttribute('tabindex')).toBeNull();
        fireEvent.click(row);
        fireEvent.keyDown(row, { key: 'Enter' });
        expect(onOpenRun).not.toHaveBeenCalled();
        expect(screen.queryByTestId('execution-row-actions')).toBeNull();
        // The row still says what happened — this is a log, and the point is
        // that a failure is visible to whoever can act on it.
        expect(screen.getAllByText('Weekly digest').length).toBeGreaterThan(0);
    });

    it('in the org scope a row is openable only when the server said it is MINE', () => {
        hookRunScope.current = 'org';
        const onOpenRun = vi.fn();
        renderTable([run({ id: 'r1', mine: true })], { runScope: 'org', onOpenRun });
        expect(screen.getByTestId('execution-row').getAttribute('data-can-open')).toBe('true');
        cleanup();
        // Absent is not permission: an older or partial server that omits the
        // field must close the door, not leave it ajar.
        renderTable([run({ id: 'r2' })], { runScope: 'org', onOpenRun });
        expect(screen.getByTestId('execution-row').getAttribute('data-can-open')).toBe('false');
    });

    it('stands the live stream down in the org scope, so the list cannot look half-live', () => {
        hookRunScope.current = 'org';
        renderTable([run()], { runScope: 'org' });
        expect(streamCalls.current.at(-1).enabled).toBe(false);
        cleanup();
        streamCalls.current = [];
        hookRunScope.current = 'mine';
        renderTable([run()]);
        expect(streamCalls.current.at(-1).enabled).toBe(true);
    });
});

// ── The picker above the rows must be scoped like the rows ───────────

describe('the automation picker follows the scope', () => {
    it('forgets the organisation\'s routine names when you go back to your own runs', () => {
        // THE LEAK. The picker's options are accumulated across loaded pages so
        // that filtering by one routine does not drop the others. Nothing reset
        // that store when the SCOPE changed, so a visit to the organisation
        // scope filled it with colleagues' routine names — and they stayed
        // listed under "my runs". The rows were scoped correctly throughout;
        // the control above them was not, which is the kind of leak that never
        // shows up in a query test.
        filterBarProps.current = [];
        hookRunScope.current = 'org';
        rows.current = [
            { id: 'r1', automationId: 'a-colleague', automationTitle: 'Payroll export', status: 'success', startedAt: new Date().toISOString() },
        ];
        const { rerender } = render(<ExecutionsTable scope="global" runScope="org" />);
        expect(filterBarProps.current.at(-1).automationOptions.map(o => o.title)).toEqual(['Payroll export']);

        hookRunScope.current = 'mine';
        rows.current = [
            { id: 'r2', automationId: 'a-mine', automationTitle: 'My digest', status: 'success', startedAt: new Date().toISOString() },
        ];
        rerender(<ExecutionsTable scope="global" runScope="mine" />);

        const titles = filterBarProps.current.at(-1).automationOptions.map(o => o.title);
        expect(titles).toEqual(['My digest']);
        expect(titles).not.toContain('Payroll export');
    });

    it('still accumulates WITHIN one scope — that is what the store is for', () => {
        filterBarProps.current = [];
        hookRunScope.current = 'mine';
        rows.current = [
            { id: 'r1', automationId: 'a1', automationTitle: 'Alpha', status: 'success', startedAt: new Date().toISOString() },
        ];
        const { rerender } = render(<ExecutionsTable scope="global" runScope="mine" />);
        rows.current = [
            { id: 'r2', automationId: 'a2', automationTitle: 'Beta', status: 'success', startedAt: new Date().toISOString() },
        ];
        rerender(<ExecutionsTable scope="global" runScope="mine" />);
        expect(filterBarProps.current.at(-1).automationOptions.map(o => o.title)).toEqual(['Alpha', 'Beta']);
    });
});
