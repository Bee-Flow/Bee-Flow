import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import SoaPage from './SoaPage';
import { resolveTab, tabsOf } from '../sections';

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

/** 93 controls in the real theme sizes; the first control of each theme links a check. */
function soaBody() {
    const sizes = { 5: 37, 6: 8, 7: 14, 8: 34 };
    const controls = [];
    for (const [theme, n] of Object.entries(sizes)) {
        for (let i = 1; i <= n; i++) {
            controls.push({ ref: `A.${theme}.${i}`, theme: Number(theme), titleKey: `k.${theme}.${i}`, objectiveKey: `o.${theme}.${i}`, bucket: 'attest', checks: i === 1 ? [`CHK-${theme}`] : [], entry: null });
        }
    }
    controls[0].entry = { status: 'approved', applicable: true, how_met: 'Policy v3 published 3 Jul', owner_user_id: 'u1', updated_at: '2026-06-10T09:00:00Z', updated_by: null };
    controls[1].entry = { status: 'reviewed', applicable: false, justification: 'cloud only', how_met: null, owner_user_id: null, updated_at: '2026-06-10T09:00:00Z', updated_by: null };
    return { controls, stats: { total: 2, approved: 1, reviewed: 0, todo: 0, excluded: 1 } };
}

const core = { checks: [{ check_id: 'CHK-5', status: 'warn', regulation: 'ISO27001', article: 'A.5.1', titleKey: 'chk.5' }, { check_id: 'CHK-8', status: 'pass', regulation: 'ISO27001', article: 'A.8.1', titleKey: 'chk.8' }] };
const orgUsers = [{ id: 'u1', displayName: 'T. Smit', email: 't@example.com' }];

function pageProps(over = {}) {
    return {
        section: { id: 'soa' }, tab: 'controls', onTab: vi.fn(), navigate: vi.fn(), focusId: null, exportsEnabled: true,
        dl: (url) => url, isMobile: false,
        data: { core, orgUsers, soa: { soa: soaBody(), busyRef: null, seed: vi.fn(), update: vi.fn(), refresh: vi.fn() } },
        ...over,
    };
}

describe('SoaPage — controls tab', () => {
    it('the theme is one compact select with its counts (93 · 37 · 8 · 14 · 34), beside the decision pills and the search', () => {
        render(<SoaPage {...pageProps()} />);
        const select = screen.getByTestId('soa-theme');
        expect(select.tagName).toBe('SELECT');
        expect(select.getAttribute('aria-label')).toBe('Theme');
        expect(Array.from(select.options).map(o => o.textContent)).toEqual([
            'All themes · 93', 'A.5 Organisational · 37', 'A.6 People · 8', 'A.7 Physical · 14', 'A.8 Technological · 34',
        ]);
        // One toolbar row: pills, theme and search share a parent.
        const row = select.closest('div');
        expect(within(row).getByTestId('soa-search')).toBeTruthy();
        expect(within(row).getByTestId('soa-decision-all')).toBeTruthy();
        expect(screen.getByTestId('soa-decision-all').textContent).toMatch(/93/);
        expect(screen.getByTestId('soa-decision-approved').textContent).toMatch(/1/);
        expect(screen.getByTestId('soa-decision-excluded').textContent).toMatch(/1/);
        expect(screen.getByTestId('soa-decision-todo').textContent).toMatch(/91/);
    });

    it('pages 12 of 93 client-side; choosing a theme filters and resets the pager', async () => {
        const user = userEvent.setup();
        render(<SoaPage {...pageProps()} />);
        expect(screen.getByTestId('soa-pager-range').textContent).toBe('Rows 1–12 of 93');
        expect(screen.getAllByTestId(/^soa-table-row-/)).toHaveLength(12);
        await user.click(screen.getByTestId('soa-pager-next'));
        expect(screen.getByTestId('soa-pager-range').textContent).toBe('Rows 13–24 of 93');
        await user.selectOptions(screen.getByTestId('soa-theme'), 'A.6');
        expect(screen.getByTestId('soa-pager-range').textContent).toBe('Rows 1–8 of 8');
        expect(screen.getAllByTestId(/^soa-table-row-/).map(r => r.dataset.testid)).toEqual(Array.from({ length: 8 }, (_, i) => `soa-table-row-A.6.${i + 1}`));
    });

    it('renders the live-check column: warn with "needs attention", pass with the title, pending, and a muted dash where no check exists', async () => {
        const user = userEvent.setup();
        render(<SoaPage {...pageProps()} />);
        const first = screen.getByTestId('soa-table-row-A.5.1');
        expect(first.textContent).toMatch(/CHK-5/); // the mock t() returns the fallback = check id
        expect(first.textContent).toMatch(/needs attention/);
        expect(first.textContent).toMatch(/Approved/);
        expect(first.textContent).toMatch(/T\. Smit/);
        expect(first.textContent).toMatch(/Policy v3 published 3 Jul/);
        const excluded = screen.getByTestId('soa-table-row-A.5.2');
        const none = excluded.querySelector('[data-live="none"]');
        expect(none.getAttribute('title')).toBe('No live check covers this control');
        expect(none.querySelector('[aria-hidden="true"]').textContent).toBe('—');
        expect(excluded.textContent).not.toMatch(/no live check/);
        expect(excluded.textContent).toMatch(/Excluded/);
        expect(excluded.textContent).toMatch(/Justification: cloud only/);
        // The check cell truncates inside its own track, so its text cannot run into the Decision pill.
        const live = first.querySelector('[data-status="warn"]');
        expect(live.className).toMatch(/\bflex\b/);
        expect(live.className).toMatch(/\bw-full\b/);
        expect(live.className).toMatch(/\bmin-w-0\b/);
        await user.selectOptions(screen.getByTestId('soa-theme'), 'A.6');
        expect(screen.getByTestId('soa-table-row-A.6.1').textContent).toMatch(/not yet checked/);
    });

    it('the second line is "how met", and falls back to the justification, labelled, when a row has none', () => {
        const props = pageProps();
        const body = props.data.soa.soa;
        // still applicable, no how_met yet, but a written justification
        body.controls[2].entry = { status: 'todo', applicable: true, how_met: null, justification: 'Bought in as a service — see A.5.20', owner_user_id: null, updated_at: '2026-06-10T09:00:00Z' };
        render(<SoaPage {...props} />);
        expect(screen.getByTestId('soa-table-row-A.5.3').textContent).toMatch(/Justification: Bought in as a service/);
        expect(screen.getByTestId('soa-table-row-A.5.1').textContent).not.toMatch(/Justification:/);
    });

    it('a row click opens the drawer; Save goes through data.soa.update(ref, patch); a second click closes it', async () => {
        const props = pageProps();
        render(<SoaPage {...props} />);
        fireEvent.click(screen.getByTestId('soa-table-row-A.5.1'));
        expect(screen.getByTestId('soa-drawer')).toBeTruthy();
        expect(screen.getByTestId('soa-drawer-decision-approved')).toBeDisabled(); // CHK-5 is warn
        fireEvent.click(screen.getByTestId('soa-drawer-decision-reviewed'));
        fireEvent.click(screen.getByTestId('soa-drawer-actions-primary'));
        await waitFor(() => expect(props.data.soa.update).toHaveBeenCalledWith('A.5.1', expect.objectContaining({ status: 'reviewed', applicable: true })));
        expect(fetchJson).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('soa-table-row-A.5.1'));
        expect(screen.queryByTestId('soa-drawer')).toBeNull();
    });

    it('falls back to PUT /iso/soa/:ref through fetchJson when the hook has no update()', async () => {
        const props = pageProps();
        const refresh = vi.fn();
        props.data.soa = { soa: soaBody(), busyRef: null, refresh };
        fetchJson.mockResolvedValue({ ok: true });
        render(<SoaPage {...props} />);
        fireEvent.click(screen.getByTestId('soa-table-row-A.5.1'));
        fireEvent.click(screen.getByTestId('soa-drawer-actions-primary'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalled());
        const [url, init] = fetchJson.mock.calls[0];
        expect(url).toMatch(/\/api\/compliance\/iso\/soa\/A\.5\.1$/);
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ status: 'approved', applicable: true, justification: null, how_met: 'Policy v3 published 3 Jul', owner_user_id: 'u1' });
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('loading shows the skeleton; a failed read is its own state (never an empty table)', () => {
        const loading = pageProps(); loading.data.soa = { soa: null };
        const { unmount } = render(<SoaPage {...loading} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('soa-pager-range')).toBeNull();
        unmount();
        const failed = pageProps(); failed.data.soa = { soa: { error: '500 boom' } };
        render(<SoaPage {...failed} />);
        expect(screen.getByTestId('soa-failed')).toBeTruthy();
        expect(screen.queryByRole('table')).toBeNull();
    });
});

describe('SoaPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal, not a 380px card pinned over the table', () => {
        render(<SoaPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('soa-table-card-A.5.1'));
        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.parentElement.className).toMatch(/\bjustify-end\b/);
        expect(screen.getByTestId('soa-drawer').dataset.mode).toBe('modal');
    });

    it('desktop keeps the inline card', () => {
        render(<SoaPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('soa-table-row-A.5.1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('soa-drawer').dataset.mode).toBe('inline');
    });
});

describe('SoaPage — history; no Export tab', () => {
    it('history: a failed GET /iso/soa/history reads as "could not be read", a list renders rows', async () => {
        fetchJson.mockRejectedValueOnce(new Error('404 Not Found'));
        const { unmount } = render(<SoaPage {...pageProps({ tab: 'history' })} />);
        await waitFor(() => expect(screen.getByTestId('soa-history-failed')).toBeTruthy());
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/iso\/soa\/history$/);
        unmount();
        fetchJson.mockResolvedValueOnce([{ id: 7, control_ref: 'A.5.1', changed_at: '2026-09-01T10:00:00Z', changed_by: 'u1', status: 'approved', applicable: true }]);
        render(<SoaPage {...pageProps({ tab: 'history' })} />);
        await waitFor(() => expect(screen.getByTestId('soa-history-row-7')).toBeTruthy());
        expect(screen.getByTestId('soa-history-row-7').textContent).toMatch(/A\.5\.1/);
        expect(screen.getByTestId('soa-history-row-7').textContent).toMatch(/T\. Smit/);
    });

    it('history on a phone: the card list, not the four-column grid', async () => {
        fetchJson.mockResolvedValueOnce([{ id: 7, control_ref: 'A.5.1', changed_at: '2026-09-01T10:00:00Z', changed_by: 'u1', status: 'approved', applicable: true }]);
        render(<SoaPage {...pageProps({ tab: 'history', isMobile: true })} />);
        await waitFor(() => expect(screen.getByTestId('soa-history-card-7')).toBeTruthy());
        expect(screen.getByTestId('soa-history-table').dataset.view).toBe('cards');
        expect(screen.queryByTestId('soa-history-row-7')).toBeNull();
        const card = screen.getByTestId('soa-history-card-7');
        expect(card.textContent).toMatch(/A\.5\.1/);
        expect(card.textContent).toMatch(/T\. Smit/);
    });

    it('history stamps carry the year when it is not this year', async () => {
        fetchJson.mockResolvedValueOnce([{ id: 8, control_ref: 'A.5.2', changed_at: '2024-03-03T09:05:07', changed_by: 'u1', status: 'reviewed', applicable: true }]);
        render(<SoaPage {...pageProps({ tab: 'history' })} />);
        await waitFor(() => expect(screen.getByTestId('soa-history-row-8')).toBeTruthy());
        expect(screen.getByTestId('soa-history-row-8').textContent).toMatch(/3 Mar 2024 09:05:07/);
    });

    it('there is no Export tab: the downloads live in the header menu, and an old ?tab=export lands on the controls', () => {
        expect(tabsOf('soa')).toEqual(['controls', 'history']);
        expect(resolveTab('soa', 'export')).toEqual({ section: 'soa', tab: 'controls' });
        render(<SoaPage {...pageProps({ tab: 'export' })} />);
        expect(screen.queryByTestId('soa-export')).toBeNull();
        expect(screen.getByTestId('soa-table')).toBeTruthy();
        expect(screen.getByTestId('soa-pager-range').textContent).toBe('Rows 1–12 of 93');
    });
});
