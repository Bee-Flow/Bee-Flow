import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import RisksPage, { matchesFilter, sortRisks } from './RisksPage';
import { severityOfScore } from './risks/RisksTable';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const fetchJson = vi.fn();
vi.mock('../data/api', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, fetchJson: (...args) => fetchJson(...args) };
});

afterEach(cleanup);
beforeEach(() => { fetchJson.mockReset(); });

const USERS = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }, { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' }];
const RISKS = [
    { id: 1, title: 'Prompt injection via KB', description: 'Poisoned document', category: 'integrity', likelihood: 4, impact: 5, score: 20, status: 'open', owner_user_id: 'u1' },
    { id: 2, title: 'Provider outage', category: 'availability', likelihood: 3, impact: 3, score: 9, status: 'treating', owner_user_id: 'u2', review_due_at: '2020-01-01' },
    { id: 3, title: 'Shadow AI use', category: 'compliance', likelihood: 2, impact: 2, score: 4, status: 'accepted', accepted_at: '2026-08-01T10:00:00Z', accepted_by: 'u1' },
    { id: 4, title: 'Old laptop', category: 'confidentiality', likelihood: 1, impact: 1, score: 1, status: 'closed' },
];
const TREATMENTS = [{ id: 11, risk_id: 2, option: 'mitigate', description: 'Second provider', due_at: '2026-10-01' }, { id: 12, risk_id: 2, option: 'transfer', description: 'SLA', done_at: '2026-09-01' }];

function pageProps(over = {}) {
    return {
        section: { id: 'risks' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null, exportsEnabled: true, dl: (u) => u, isMobile: false,
        data: {
            orgUsers: USERS,
            risks: { risks: RISKS, treatments: TREATMENTS, stats: { total: 4, high: 1 }, busyId: null, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), addTreatment: vi.fn().mockResolvedValue({}), seed: vi.fn().mockResolvedValue({}), refresh: vi.fn() },
        },
        ...over,
    };
}

describe('RisksPage — pure helpers', () => {
    it('maps the score bands to severities and filters by status, high and overdue', () => {
        expect([1, 4, 5, 9, 10, 15, 16, 25].map(severityOfScore)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
        expect(RISKS.filter(r => matchesFilter(r, 'high')).map(r => r.id)).toEqual([1]);
        expect(RISKS.filter(r => matchesFilter(r, 'overdue')).map(r => r.id)).toEqual([2]);
        expect(RISKS.filter(r => matchesFilter(r, 'accepted')).map(r => r.id)).toEqual([3]);
        expect(sortRisks(RISKS).map(r => r.id)).toEqual([1, 2, 3, 4]);
    });
});

describe('RisksPage — table', () => {
    it('renders R-{id}, the L×I score pill in the severity tone, the treatment status with its count, and the owner name', () => {
        render(<RisksPage {...pageProps()} />);
        const row = screen.getByTestId('risk-table-row-1');
        expect(row.textContent).toMatch(/R-1/);
        expect(row.textContent).toMatch(/Prompt injection via KB/);
        expect(row.textContent).toMatch(/L4 × I5/);
        expect(screen.getByTestId('risk-table-score-1').getAttribute('data-severity')).toBe('critical');
        expect(row.textContent).toMatch(/T\. Smit/);
        expect(row.textContent).not.toMatch(/@/);
        const treating = screen.getByTestId('risk-table-row-2');
        expect(treating.textContent).toMatch(/Treating/);
        expect(treating.textContent).toMatch(/· 2/);
        expect(screen.getByTestId('risk-table-overdue-2')).toBeTruthy();
        expect(screen.getByTestId('risk-filter-all').textContent).toMatch(/4/);
        expect(screen.getByTestId('risk-filter-high').textContent).toMatch(/1/);
    });

    it('filter pills narrow the rows; search matches the title', () => {
        render(<RisksPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('risk-filter-treating'));
        expect(screen.getAllByTestId(/^risk-table-row-/)).toHaveLength(1);
        fireEvent.click(screen.getByTestId('risk-filter-all'));
        fireEvent.change(screen.getByTestId('risk-search'), { target: { value: 'shadow' } });
        expect(screen.getAllByTestId(/^risk-table-row-/).map(r => r.getAttribute('data-testid'))).toEqual(['risk-table-row-3']);
    });

    it('loading shows the skeleton; a failed read is its own state', () => {
        const loading = pageProps(); loading.data.risks = { risks: null };
        const { unmount } = render(<RisksPage {...loading} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        unmount();
        const failed = pageProps(); failed.data.risks = { risks: { error: 'boom' } };
        render(<RisksPage {...failed} />);
        expect(screen.getByTestId('risk-failed')).toBeTruthy();
    });
});

describe('RisksPage — drawer and create', () => {
    it('the drawer edits through update(id, patch), accepts explicitly, and adds a treatment through addTreatment', async () => {
        const props = pageProps();
        render(<RisksPage {...props} />);
        fireEvent.click(screen.getByTestId('risk-table-row-2'));
        const drawer = screen.getByTestId('risk-drawer');
        expect(within(drawer).getByTestId('risk-drawer-treatments').querySelectorAll('li')).toHaveLength(2);
        fireEvent.change(within(drawer).getByTestId('risk-drawer-impact'), { target: { value: '5' } });
        expect(within(drawer).getByTestId('risk-drawer-score').textContent).toMatch(/15/);
        fireEvent.click(within(drawer).getByTestId('risk-drawer-save'));
        expect(props.data.risks.update).toHaveBeenCalledWith(2, {
            title: 'Provider outage', description: null, category: 'availability', likelihood: 3, impact: 5, status: 'treating', owner_user_id: 'u2', review_due_at: '2020-01-01',
        });
        fireEvent.click(within(drawer).getByTestId('risk-drawer-accept'));
        expect(props.data.risks.update).toHaveBeenCalledWith(2, { status: 'accepted' });
        fireEvent.change(within(drawer).getByTestId('risk-drawer-t-desc'), { target: { value: 'Failover runbook' } });
        fireEvent.click(within(drawer).getByTestId('risk-drawer-t-add'));
        await waitFor(() => expect(props.data.risks.addTreatment).toHaveBeenCalledWith(2, { option: 'mitigate', description: 'Failover runbook', due_at: undefined }));
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it('an accepted risk shows the who/when stamp instead of the accept button', () => {
        render(<RisksPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('risk-table-row-3'));
        expect(screen.getByTestId('risk-drawer-accepted').textContent).toMatch(/Accepted by T\. Smit on/);
        expect(screen.queryByTestId('risk-drawer-accept')).toBeNull();
    });

    it('"Add risk" opens the modal and creates through create(fields); the seed button calls seed()', async () => {
        const props = pageProps();
        render(<RisksPage {...props} />);
        fireEvent.click(screen.getByTestId('risk-add'));
        fireEvent.change(screen.getByTestId('risk-create-title'), { target: { value: 'Model drift' } });
        fireEvent.change(screen.getByTestId('risk-create-likelihood'), { target: { value: '2' } });
        fireEvent.change(screen.getByTestId('risk-create-owner'), { target: { value: 'u2' } });
        fireEvent.click(screen.getByTestId('risk-create-submit'));
        await waitFor(() => expect(props.data.risks.create).toHaveBeenCalledWith({ title: 'Model drift', description: undefined, category: 'confidentiality', likelihood: 2, impact: 3, owner_user_id: 'u2' }));
        fireEvent.click(screen.getByTestId('risk-seed'));
        expect(props.data.risks.seed).toHaveBeenCalled();
    });

    it('hands the header both handles through setHeaderActions — "Add risk" opens the modal, "Seed" calls seed()', () => {
        const setHeaderActions = vi.fn();
        const props = pageProps({ setHeaderActions });
        const { unmount } = render(<RisksPage {...props} />);
        expect(screen.queryByTestId('risk-add')).toBeNull();
        expect(screen.queryByTestId('risk-seed')).toBeNull();
        const actions = setHeaderActions.mock.calls[0][0];
        act(() => actions.onAddRisk());
        expect(screen.getByTestId('risk-create')).toBeTruthy();
        actions.onSeedRisks();
        expect(props.data.risks.seed).toHaveBeenCalled();
        unmount();
        expect(setHeaderActions).toHaveBeenLastCalledWith({});
    });

    it('with a header owner the page hides its own buttons and opens the modal on headerAction="create"; without hook mutations the legacy routes are used', async () => {
        const onHeaderActionHandled = vi.fn();
        const { unmount } = render(<RisksPage {...pageProps({ headerAction: 'create', onHeaderActionHandled })} />);
        expect(screen.queryByTestId('risk-add')).toBeNull();
        expect(screen.queryByTestId('risk-seed')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('risk-create')).toBeTruthy());
        expect(onHeaderActionHandled).toHaveBeenCalled();
        unmount();

        const bare = pageProps(); const refresh = vi.fn(); bare.data.risks = { risks: RISKS, treatments: [], refresh };
        fetchJson.mockResolvedValue({});
        render(<RisksPage {...bare} />);
        fireEvent.click(screen.getByTestId('risk-seed'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalled());
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/api\/compliance\/iso\/risks\/seed$/);
        expect(fetchJson.mock.calls[0][1].method).toBe('POST');
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
});

describe('RisksPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal, not a card pinned over the table', () => {
        render(<RisksPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('risk-table-card-1'));
        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog.parentElement.className).toMatch(/\bjustify-end\b/);
        expect(screen.getByTestId('risk-drawer').dataset.mode).toBe('modal');
    });

    it('desktop keeps the inline card', () => {
        render(<RisksPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('risk-table-row-1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('risk-drawer').dataset.mode).toBe('inline');
    });
});
