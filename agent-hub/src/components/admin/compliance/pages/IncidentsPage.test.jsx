import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import IncidentsPage from './IncidentsPage';

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

const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const H = 3600_000;

const INCIDENTS = [
    { id: 1, kind: 'breach', status: 'open', title: 'Lost laptop', severity: 'high', high_risk: true, detected_at: iso(-10 * H), deadline_at: iso(62 * H), notes: [] },
    { id: 2, kind: 'security_incident', status: 'authority_notified', title: 'Phishing wave', severity: 'medium', detected_at: iso(-80 * H), deadline_at: iso(-8 * H), authority_notified_at: iso(-20 * H), recipients_notified_at: iso(-70 * H) },
    { id: 3, status: 'closed', title: 'False alarm', severity: 'low', detected_at: iso(-200 * H), deadline_at: iso(-128 * H), closed_at: iso(-190 * H) },
    { id: 9, kind: 'vulnerability', status: 'open', title: 'Heap overflow in parser', severity: 'critical', cve_ids: ['CVE-2026-1234'], exploited_in_wild: true, detected_at: iso(-2 * H) },
    { id: 10, kind: 'vulnerability', status: 'early_warning_sent', title: 'Auth bypass', severity: 'high', cve_ids: [], detected_at: iso(-30 * H), early_warning_due_at: iso(-6 * H), early_warning_sent_at: iso(-20 * H), deadline_at: iso(42 * H), final_report_due_at: iso(300 * H) },
];

function pageProps(sectionId, over = {}) {
    return {
        section: { id: sectionId }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null, exportsEnabled: true, dl: (u) => u, isMobile: false,
        data: { incidents: { incidents: INCIDENTS, busyId: null, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), notify: vi.fn().mockResolvedValue({}), craReport: vi.fn().mockResolvedValue({}), customerNotified: vi.fn().mockResolvedValue({}), refresh: vi.fn() } },
        ...over,
    };
}

describe('IncidentsPage — the incidents register', () => {
    it('opens on the Open filter; All shows only breach / security_incident rows (no kind = breach), INC- ids, running clocks first', async () => {
        const user = userEvent.setup();
        render(<IncidentsPage {...pageProps('incidents')} />);
        expect(screen.getByTestId('inc-filter-open')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getAllByTestId(/^inc-table-row-/).map(r => r.getAttribute('data-testid'))).toEqual(['inc-table-row-1']);
        await user.click(screen.getByTestId('inc-filter-all'));
        const rows = screen.getAllByTestId(/^inc-table-row-/);
        expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['inc-table-row-1', 'inc-table-row-2', 'inc-table-row-3']);
        expect(rows[0].textContent).toMatch(/INC-1/);
        expect(rows[0].textContent).toMatch(/Lost laptop/);
        expect(screen.queryByText('Heap overflow in parser')).toBeNull();
        expect(screen.getByTestId('inc-filter-all').textContent).toMatch(/3/);
        expect(screen.getByTestId('inc-filter-open').textContent).toMatch(/1/);
        expect(screen.getByTestId('inc-filter-reported').textContent).toMatch(/1/);
        expect(screen.getByTestId('inc-filter-closed').textContent).toMatch(/1/);
    });

    it('the clock column runs the 72 h Art. 33 clock; a notified row shows its completion; a closed, unnotified row reads "closed · not notified"', async () => {
        const user = userEvent.setup();
        render(<IncidentsPage {...pageProps('incidents')} />);
        await user.click(screen.getByTestId('inc-filter-all'));
        expect(screen.getByTestId('inc-table-clock-1').getAttribute('data-state')).toBe('ok');
        expect(screen.getByTestId('inc-table-clock-1').getAttribute('data-unit')).toBe('hours');
        expect(screen.getByTestId('inc-table-clock-2').getAttribute('data-state')).toBe('done');
        const closed = screen.getByTestId('inc-table-clock-3');
        expect(closed).toHaveAttribute('data-state', 'not_filed');
        expect(closed).toHaveTextContent('closed · not notified');
        expect(closed.className).toContain('text-[var(--text-tertiary)]');
        expect(screen.getByTestId('inc-table-row-3')).not.toHaveTextContent(/overdue/);
    });

    it('the Next step column names the running stage in words (with the filed count for a screen reader), or All filed / Closed', async () => {
        const user = userEvent.setup();
        render(<IncidentsPage {...pageProps('incidents')} />);
        await user.click(screen.getByTestId('inc-filter-all'));
        expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Deadline', 'Incident', 'Occurred', 'Next step', 'Status']);
        expect(screen.getByTestId('inc-table-next-1')).toHaveTextContent('Authority notification (72 h) · 0 of 1 filed');
        expect(screen.getByTestId('inc-table-next-2')).toHaveTextContent('All filed · 1 of 1 filed');
        expect(screen.getByTestId('inc-table-next-3')).toHaveTextContent('Closed');
        expect(screen.queryByTestId('reported-stamps')).toBeNull();
    });

    it('severity reads in incident words (High, Medium), never the check vocabulary; the status is the shared register pill', async () => {
        const user = userEvent.setup();
        render(<IncidentsPage {...pageProps('incidents')} />);
        await user.click(screen.getByTestId('inc-filter-all'));
        expect(screen.getByTestId('inc-table-severity-1')).toHaveTextContent('High');
        expect(screen.getByTestId('inc-table-severity-2')).toHaveTextContent('Medium');
        expect(screen.getByTestId('inc-table-severity-2')).toHaveAttribute('data-vocabulary', 'incident');
        expect(screen.getByTestId('inc-table-row-2')).not.toHaveTextContent(/Consider/i);
        expect(screen.getByTestId('inc-table-status-1')).toHaveAttribute('data-tone', 'neutral');
        expect(screen.getByTestId('inc-table-status-3')).toHaveAttribute('data-tone', 'success');
    });

    it('a deep link opens the drawer for a string id as well as a number', () => {
        const rows = [{ id: 'inc_32', kind: 'security_incident', status: 'open', title: 'Connector down', severity: 'medium', detected_at: iso(-3 * H), deadline_at: iso(69 * H) }];
        const props = pageProps('incidents', { focusId: 'inc_32' });
        props.data.incidents.incidents = rows;
        const { unmount } = render(<IncidentsPage {...props} />);
        expect(screen.getByTestId('inc-drawer-header')).toHaveTextContent('Connector down');
        unmount();
        render(<IncidentsPage {...pageProps('incidents', { focusId: '1' })} />);
        expect(screen.getByTestId('inc-drawer-header')).toHaveTextContent('Lost laptop');
    });

    it('a row click opens the drawer with the GDPR actions; the attestations go through data.incidents.update', async () => {
        const props = pageProps('incidents');
        render(<IncidentsPage {...props} />);
        fireEvent.click(screen.getByTestId('inc-table-row-1'));
        const drawer = screen.getByTestId('inc-drawer');
        fireEvent.click(within(drawer).getByTestId('inc-drawer-assess'));
        expect(props.data.incidents.update).toHaveBeenCalledWith(1, { status: 'assessing' });
        fireEvent.change(within(drawer).getByTestId('inc-drawer-authority-ref'), { target: { value: 'AP-2026-77' } });
        fireEvent.click(within(drawer).getByTestId('inc-drawer-authority'));
        expect(props.data.incidents.update).toHaveBeenCalledWith(1, { status: 'authority_notified', authority_reference: 'AP-2026-77' });
        fireEvent.click(within(drawer).getByTestId('inc-drawer-notify'));
        expect(props.data.incidents.notify).toHaveBeenCalledWith(1);
        expect(within(drawer).getByTestId('inc-drawer-subjects')).toBeTruthy(); // high_risk → Art. 34
        expect(within(drawer).queryByTestId('inc-drawer-cra')).toBeNull();
        expect(fetchJson).not.toHaveBeenCalled();
    });

    it('"Record incident" opens the modal and creates through data.incidents.create with an allow-listed body', async () => {
        const props = pageProps('incidents');
        render(<IncidentsPage {...props} />);
        fireEvent.click(screen.getByTestId('inc-record'));
        fireEvent.change(screen.getByTestId('inc-create-title'), { target: { value: 'Misdirected e-mail' } });
        fireEvent.click(screen.getByTestId('inc-create-high-risk'));
        fireEvent.click(screen.getByTestId('inc-create-submit'));
        await waitFor(() => expect(props.data.incidents.create).toHaveBeenCalledTimes(1));
        const body = props.data.incidents.create.mock.calls[0][0];
        expect(body).toEqual({ kind: 'breach', title: 'Misdirected e-mail', description: undefined, severity: 'medium', occurred_at: undefined, detected_at: expect.any(String), high_risk: true });
        // "Became aware at" defaults to now (to the minute)
        expect(Math.abs(new Date(body.detected_at).getTime() - Date.now())).toBeLessThan(2 * 60_000);
    });

    it('"Became aware at" sits next to "Occurred at": a breach found yesterday is recorded with yesterday, and the future is refused', async () => {
        const user = userEvent.setup();
        const props = pageProps('incidents');
        render(<IncidentsPage {...props} />);
        await user.click(screen.getByTestId('inc-record'));
        expect(screen.getByRole('dialog')).toHaveTextContent('The reporting clocks run from the moment your organisation became aware of the breach.');
        const aware = screen.getByLabelText('Became aware at');
        expect(aware).toHaveAccessibleDescription('The 72-hour clock runs from here');
        expect(aware).toHaveAttribute('max');
        await user.type(screen.getByTestId('inc-create-title'), 'Found in yesterday\'s logs');
        const pad = (n) => String(n).padStart(2, '0');
        const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const tomorrow = new Date(Date.now() + 24 * H);
        fireEvent.change(aware, { target: { value: local(tomorrow) } });
        expect(screen.getByTestId('inc-create-submit')).toBeDisabled();
        const yesterday = new Date(Date.now() - 24 * H);
        fireEvent.change(aware, { target: { value: local(yesterday) } });
        await user.click(screen.getByTestId('inc-create-submit'));
        await waitFor(() => expect(props.data.incidents.create).toHaveBeenCalledTimes(1));
        expect(props.data.incidents.create.mock.calls[0][0].detected_at).toBe(new Date(local(yesterday)).toISOString());
    });

    it('the header primary arrives as headerAction="create": the modal opens, the page hides its own button and reports back', async () => {
        const onHeaderActionHandled = vi.fn();
        render(<IncidentsPage {...pageProps('incidents', { headerAction: 'create', onHeaderActionHandled })} />);
        expect(screen.queryByTestId('inc-record')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('inc-create')).toBeTruthy());
        expect(onHeaderActionHandled).toHaveBeenCalled();
    });

    it('hands the header its primary through setHeaderActions, and takes it back on unmount', () => {
        const setHeaderActions = vi.fn();
        const { unmount } = render(<IncidentsPage {...pageProps('incidents', { setHeaderActions })} />);
        expect(screen.queryByTestId('inc-record')).toBeNull(); // the header draws it
        expect(setHeaderActions).toHaveBeenCalledWith(expect.objectContaining({ onRecordIncident: expect.any(Function) }));
        act(() => setHeaderActions.mock.calls[0][0].onRecordIncident());
        expect(screen.getByTestId('inc-create')).toBeTruthy();
        unmount();
        expect(setHeaderActions).toHaveBeenLastCalledWith({});
    });

    it('the vulnerability register registers its own primary', () => {
        const setHeaderActions = vi.fn();
        render(<IncidentsPage {...pageProps('vulnerabilities', { setHeaderActions })} />);
        expect(setHeaderActions).toHaveBeenCalledWith(expect.objectContaining({ onRecordVulnerability: expect.any(Function) }));
        expect(setHeaderActions.mock.calls[0][0].onRecordIncident).toBeUndefined();
    });

    it('loading → skeleton; a failed read is its own state; without hook mutations the legacy routes are used', async () => {
        const loading = pageProps('incidents'); loading.data.incidents = { incidents: null };
        const { unmount } = render(<IncidentsPage {...loading} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        unmount();
        const failed = pageProps('incidents'); failed.data.incidents = { incidents: { error: 'boom' } };
        const r2 = render(<IncidentsPage {...failed} />);
        expect(screen.getByTestId('inc-failed')).toBeTruthy();
        r2.unmount();
        const bare = pageProps('incidents'); const refresh = vi.fn(); bare.data.incidents = { incidents: INCIDENTS, refresh };
        fetchJson.mockResolvedValue({});
        render(<IncidentsPage {...bare} />);
        fireEvent.click(screen.getByTestId('inc-table-row-1'));
        fireEvent.click(screen.getByTestId('inc-drawer-assess'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalled());
        expect(fetchJson.mock.calls[0][0]).toMatch(/\/api\/compliance\/incidents\/1$/);
        expect(fetchJson.mock.calls[0][1].method).toBe('PUT');
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
});

describe('IncidentsPage — the vulnerability register (CRA Art. 14)', () => {
    it('shows only kind=vulnerability rows with VULN- ids, CVE ids, the exploited flag and the CRA clocks', () => {
        render(<IncidentsPage {...pageProps('vulnerabilities')} />);
        expect(screen.getByTestId('vuln-page').getAttribute('data-kind')).toBe('vulnerability');
        const rows = screen.getAllByTestId(/^inc-table-row-/);
        // both running: sorted by next due — 9's derived 24 h early warning (+22 h) before 10's 72 h notification (+42 h)
        expect(rows.map(r => r.getAttribute('data-testid'))).toEqual(['inc-table-row-9', 'inc-table-row-10']);
        expect(screen.getByTestId('inc-table-row-9').textContent).toMatch(/VULN-9/);
        expect(screen.getByTestId('inc-table-row-9').textContent).toMatch(/CVE-2026-1234/);
        expect(screen.getByTestId('inc-table-row-9').textContent).toMatch(/exploited/);
        expect(screen.queryByText('Lost laptop')).toBeNull();
        // 9 has no server clocks → derived 24 h early warning, still running
        expect(screen.getByTestId('inc-table-clock-9').getAttribute('data-state')).toBe('ok');
        expect(screen.getByTestId('inc-table-clock-9').getAttribute('data-unit')).toBe('hours');
        // 10 sent its early warning → the 72 h notification clock runs
        expect(screen.getByTestId('inc-table-clock-10').getAttribute('data-state')).toBe('ok');
    });

    it('reads the hub\'s own `vulnerabilities` hook when it is handed one, and falls back to `incidents` when it is not', async () => {
        const vulnerabilities = {
            incidents: [{ id: 77, kind: 'vulnerability', status: 'open', title: 'Only in the vuln hook', severity: 'high', cve_ids: ['CVE-2026-7777'], detected_at: iso(-1 * H) }],
            busyId: null, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), notify: vi.fn(),
            craReport: vi.fn().mockResolvedValue({}), customerNotified: vi.fn().mockResolvedValue({}), refresh: vi.fn(),
        };
        const props = pageProps('vulnerabilities');
        render(<IncidentsPage {...props} data={{ ...props.data, vulnerabilities }} />);
        expect(screen.getAllByTestId(/^inc-table-row-/).map(r => r.getAttribute('data-testid'))).toEqual(['inc-table-row-77']);
        fireEvent.click(screen.getByTestId('inc-table-row-77'));
        fireEvent.click(screen.getByTestId('inc-drawer-cra-early'));
        await waitFor(() => expect(vulnerabilities.craReport).toHaveBeenCalledWith(77, expect.objectContaining({ stage: 'early_warning' })));
        expect(props.data.incidents.craReport).not.toHaveBeenCalled();

        // the incidents section never reaches for the vulnerability hook
        cleanup();
        const p2 = pageProps('incidents');
        render(<IncidentsPage {...p2} data={{ ...p2.data, vulnerabilities }} />);
        expect(screen.queryByTestId('inc-table-row-77')).toBeNull();
        expect(screen.getByTestId('inc-table-row-1')).toBeTruthy();
    });

    it('the drawer offers "Report early warning" first, then "Report full", and "Customer notified"; they hit craReport / customerNotified', () => {
        const props = pageProps('vulnerabilities');
        render(<IncidentsPage {...props} />);
        fireEvent.click(screen.getByTestId('inc-table-row-9'));
        let drawer = screen.getByTestId('inc-drawer');
        expect(within(drawer).getByTestId('inc-drawer-reporting').querySelectorAll('li')).toHaveLength(4);
        fireEvent.change(within(drawer).getByTestId('inc-drawer-cra-via'), { target: { value: 'ENISA SRP' } });
        fireEvent.change(within(drawer).getByTestId('inc-drawer-cra-ref'), { target: { value: 'SRP-1' } });
        fireEvent.click(within(drawer).getByTestId('inc-drawer-cra-early'));
        expect(props.data.incidents.craReport).toHaveBeenCalledWith(9, { stage: 'early_warning', reported_via: 'ENISA SRP', reference: 'SRP-1' });
        expect(within(drawer).queryByTestId('inc-drawer-cra-full')).toBeNull();
        fireEvent.click(within(drawer).getByTestId('inc-drawer-cra-customers'));
        expect(props.data.incidents.customerNotified).toHaveBeenCalledWith(9);
        expect(within(drawer).queryByTestId('inc-drawer-authority')).toBeNull(); // no GDPR attestations on a CRA row

        fireEvent.click(screen.getByTestId('inc-table-row-10'));
        drawer = screen.getByTestId('inc-drawer');
        expect(within(drawer).queryByTestId('inc-drawer-cra-early')).toBeNull();
        fireEvent.click(within(drawer).getByTestId('inc-drawer-cra-full'));
        expect(props.data.incidents.craReport).toHaveBeenCalledWith(10, { stage: 'full', reported_via: undefined, reference: undefined });
    });

    it('degrades when the CRA routes 404: the buttons disable and a sentence says why', async () => {
        const props = pageProps('vulnerabilities');
        props.data.incidents.craReport = vi.fn().mockRejectedValue(new Error('404 Not Found'));
        render(<IncidentsPage {...props} />);
        fireEvent.click(screen.getByTestId('inc-table-row-9'));
        fireEvent.click(screen.getByTestId('inc-drawer-cra-early'));
        await waitFor(() => expect(screen.getByTestId('inc-drawer-cra-unavailable')).toBeTruthy());
        expect(screen.getByTestId('inc-drawer-cra-early')).toBeDisabled();
        expect(screen.getByTestId('inc-drawer-cra-customers')).toBeDisabled();
    });

    it('"Record vulnerability" sends kind=vulnerability with CVE ids and the exploited flag', async () => {
        const props = pageProps('vulnerabilities');
        render(<IncidentsPage {...props} />);
        fireEvent.click(screen.getByTestId('inc-record'));
        fireEvent.change(screen.getByTestId('inc-create-title'), { target: { value: 'RCE in export' } });
        fireEvent.change(screen.getByTestId('inc-create-cve'), { target: { value: 'cve-2026-9 CVE-2026-10' } });
        fireEvent.click(screen.getByTestId('inc-create-exploited'));
        fireEvent.click(screen.getByTestId('inc-create-submit'));
        await waitFor(() => expect(props.data.incidents.create).toHaveBeenCalledTimes(1));
        expect(props.data.incidents.create.mock.calls[0][0]).toMatchObject({ kind: 'vulnerability', title: 'RCE in export', cve_ids: ['CVE-2026-9', 'CVE-2026-10'], exploited_in_wild: true });
        expect('high_risk' in props.data.incidents.create.mock.calls[0][0]).toBe(false);
    });
});

describe('IncidentsPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal; desktop keeps the inline card', () => {
        const { unmount } = render(<IncidentsPage {...pageProps('incidents', { isMobile: true })} />);
        fireEvent.click(screen.getByTestId('inc-table-card-1'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('inc-drawer').dataset.mode).toBe('modal');
        unmount();
        render(<IncidentsPage {...pageProps('incidents')} />);
        fireEvent.click(screen.getByTestId('inc-table-row-1'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('inc-drawer').dataset.mode).toBe('inline');
    });
});
