import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnswersDashboard from './AnswersDashboard';
import { defaultRange, rangeToQuery } from './answersRange';
import { datatablesApi } from '../../Datatables/datatablesApi';

/**
 * The answers dashboard, from one summary: four tiles, a timeline that
 * draws, a card per question shaped by its type, the retired ones folded
 * away, a response that opens in a drawer, a range that refetches, the
 * empty state — and never a purple hue.
 */

vi.mock('../../Datatables/datatablesApi', () => {
    const datatablesApi = {
        answersSummary: vi.fn(), getRow: vi.fn(), exportCsv: vi.fn(), getSchema: vi.fn(), listRows: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});
// The embedded rows table is its own suite; here it is a marker.
vi.mock('../../Datatables/RowBrowser', () => ({
    default: ({ initialFilters }) => <div data-testid="rows-stub" data-filters={JSON.stringify(initialFilters || null)} />,
}));

const FORBIDDEN = [/#6366f1/i, /#4f46e5/i, /#818cf8/i, /#7c3aed/i, /#a855f7/i, /indigo/i, /violet/i, /purple/i];

const SUMMARY = {
    table: { id: 'tbl_a', name: 'Answers — Customer feedback', rowCount: 128, retentionDays: null },
    form: { automationId: 'au1', title: 'Customer feedback', live: true, url: '/f/tok', linked: true, mine: true },
    range: { from: '2026-08-15', to: '2026-09-13', bucket: 'day' },
    totals: { all: 128, inRange: 86, last7d: 20, today: 4, completed: 86, open: 0, lastAt: '2026-09-13T10:00:00Z' },
    timeline: [{ bucket: '2026-09-12', n: 3 }, { bucket: '2026-09-13', n: 4 }],
    questions: [
        { fieldId: 'f1', key: 'source', label: 'How did you hear about us?', formType: 'select', columnType: 'select', pageStepId: null, retired: false, answered: 84, skipped: 2,
            breakdown: { kind: 'choice', values: [{ value: 'search', n: 41, pct: 48.8 }, { value: 'colleague', n: 24, pct: 28.6 }] } },
        { fieldId: 'f2', key: 'subscribe', label: 'Subscribe to updates?', formType: 'checkbox', columnType: 'bool', pageStepId: null, retired: false, answered: 86, skipped: 0,
            breakdown: { kind: 'yesno', yes: 61, no: 25 } },
        { fieldId: 'f3', key: 'team', label: 'Team size', formType: 'number', columnType: 'number', pageStepId: null, retired: false, answered: 80, skipped: 6,
            breakdown: { kind: 'number', avg: 14, min: 1, max: 120, p50: 9 } },
        { fieldId: 'f4', key: 'more', label: 'Anything else?', formType: 'textarea', columnType: 'text', pageStepId: null, retired: false, answered: 37, skipped: 49,
            breakdown: { kind: 'text', recent: [{ rowId: 'r1', value: 'Great onboarding, thanks', at: '2026-09-13T09:00:00Z' }, { rowId: 'r2', value: 'Please add SSO', at: '2026-09-12T09:00:00Z' }] } },
        { fieldId: 'f5', key: 'old', label: 'Old question', formType: 'text', columnType: 'text', pageStepId: null, retired: true, answered: 3, skipped: 83,
            breakdown: { kind: 'text', recent: [] } },
    ],
    recent: [
        { rowId: 'r1', submittedAt: '2026-09-13T09:00:00Z', completedAt: '2026-09-13T09:00:00Z', runId: 'run_1', by: { id: 'u2', name: 'Anna de Vries' }, preview: { source: 'search', subscribe: 'true', team: '12' } },
        { rowId: 'r2', submittedAt: '2026-09-12T09:00:00Z', completedAt: null, runId: null, by: null, preview: { source: 'colleague' } },
    ],
};

function renderDash(props = {}) {
    return render(<AnswersDashboard datatableId="tbl_a" grade="owner" mine automationId="au1" onNavigate={vi.fn()} {...props} />);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.answersSummary.mockResolvedValue(SUMMARY);
    datatablesApi.getRow.mockResolvedValue({ row: { id: 'r1', source: 'search', subscribe: true, team: 12, more: 'Great onboarding, thanks', old: null } });
});
afterEach(() => { vi.useRealTimers(); });

describe('answersRange', () => {
    it('turns presets into inclusive calendar days and "all" into no bounds', () => {
        const now = new Date(2026, 8, 13, 15, 0, 0);
        expect(rangeToQuery({ preset: 'today' }, now)).toEqual({ from: '2026-09-13', to: '2026-09-13' });
        expect(rangeToQuery({ preset: '7d' }, now)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
        expect(rangeToQuery(defaultRange(), now)).toEqual({ from: '2026-08-15', to: '2026-09-13' });
        expect(rangeToQuery({ preset: 'all' }, now)).toEqual({ from: null, to: null });
        expect(rangeToQuery({ preset: 'custom', from: '2026-01-01', to: 'nope' }, now)).toEqual({ from: '2026-01-01', to: null });
    });
});

describe('<AnswersDashboard>', () => {
    it('draws the four tiles, the timeline, one card per live question by type, and the retired ones folded away', async () => {
        const { container } = renderDash();
        await screen.findByTestId('answers-kpis');
        expect(screen.getByLabelText('Responses in this period: 86')).toBeTruthy();
        expect(screen.getByLabelText('All time: 128')).toBeTruthy();
        expect(screen.getByLabelText('Today: 4')).toBeTruthy();
        expect(screen.getByTestId('kpi-last')).toBeTruthy();
        // the summary was asked for the default 30-day window
        const [, range] = datatablesApi.answersSummary.mock.calls[0];
        expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // the timeline draws
        expect(within(screen.getByTestId('answers-timeline')).getByRole('img', { name: 'Responses over time' })).toBeTruthy();
        expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
        // per type
        const choice = screen.getByTestId('question-source');
        expect(within(choice).getByText('search')).toBeTruthy();
        expect(within(choice).getByText('48.8%')).toBeTruthy();
        expect(within(choice).getByText('84 answered · 2 skipped')).toBeTruthy();
        expect(within(screen.getByTestId('question-subscribe')).getByText('Yes')).toBeTruthy();
        expect(within(screen.getByTestId('question-team')).getByText('Average')).toBeTruthy();
        expect(within(screen.getByTestId('question-more')).getByText('“Great onboarding, thanks”')).toBeTruthy();
        // retired: folded, counted
        expect(screen.getByText('No longer on the form (1)')).toBeTruthy();
        expect(screen.queryByTestId('question-old')).toBeNull();
        fireEvent.click(screen.getByText('No longer on the form (1)'));
        expect(await screen.findByTestId('question-old')).toBeTruthy();
        for (const re of FORBIDDEN) expect(container.innerHTML).not.toMatch(re);
    });

    it('a recent response opens the drawer with every answer, and "Open the run" only for the owner', async () => {
        const onNavigate = vi.fn();
        renderDash({ onNavigate });
        const rows = await screen.findAllByTestId('recent-row');
        expect(rows[0].textContent).toContain('Anna de Vries');
        expect(rows[1].textContent).toContain('Anonymous');
        fireEvent.click(rows[0]);
        await waitFor(() => expect(datatablesApi.getRow).toHaveBeenCalledWith('tbl_a', 'r1'));
        const answers = await screen.findByTestId('response-answers');
        expect(answers.textContent).toContain('How did you hear about us?');
        expect(answers.textContent).toContain('search');
        expect(answers.textContent).toContain('Yes');
        expect(answers.textContent).toContain('Not answered');
        fireEvent.click(screen.getByTestId('drawer-open-run'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/au1?run=run_1');
    });

    it('a viewer gets no "Open the run"', async () => {
        renderDash({ mine: false, grade: 'viewer' });
        const rows = await screen.findAllByTestId('recent-row');
        fireEvent.click(rows[0]);
        await screen.findByTestId('response-answers');
        expect(screen.queryByTestId('drawer-open-run')).toBeNull();
    });

    it('"See all answers" narrows the responses table to that question; a preset change refetches with the new days', async () => {
        renderDash();
        await screen.findByTestId('question-more');
        fireEvent.click(within(screen.getByTestId('question-more')).getByText('See all answers →'));
        expect(screen.getByTestId('rows-stub').getAttribute('data-filters')).toBe(JSON.stringify([{ field: 'more', op: 'isNotNull' }]));
        expect(screen.getByText('Show every response')).toBeTruthy();
        fireEvent.click(screen.getByRole('radio', { name: 'All' }));
        await waitFor(() => expect(datatablesApi.answersSummary).toHaveBeenLastCalledWith('tbl_a', { from: null, to: null }));
    });

    it('refetches every 30 s only while the page is visible', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        renderDash();
        await screen.findByTestId('answers-kpis');
        expect(datatablesApi.answersSummary).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        await vi.advanceTimersByTimeAsync(30_500);
        expect(datatablesApi.answersSummary).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        await vi.advanceTimersByTimeAsync(30_500);
        expect(datatablesApi.answersSummary).toHaveBeenCalledTimes(2);
    });

    it('with no responses at all it says so and offers the link', async () => {
        datatablesApi.answersSummary.mockResolvedValue({ ...SUMMARY, totals: { ...SUMMARY.totals, all: 0, inRange: 0 }, recent: [], timeline: [] });
        const onCopyLink = vi.fn();
        renderDash({ onCopyLink });
        expect(await screen.findByText('No responses yet')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Copy the link' }));
        expect(onCopyLink).toHaveBeenCalled();
        expect(screen.queryByTestId('answers-kpis')).toBeNull();
    });

    it('a failed read says so and can retry', async () => {
        datatablesApi.answersSummary.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(SUMMARY);
        renderDash();
        expect(await screen.findByRole('alert')).toBeTruthy();
        fireEvent.click(screen.getByText('Try again'));
        expect(await screen.findByTestId('answers-kpis')).toBeTruthy();
    });
});
