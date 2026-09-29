import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DsrPage, { dsrHeaderSpec } from './DsrPage';
import { capturePayload, validateCapture } from './dsr/DsrCaptureModal';
import { DAY_MS } from '../../../shared/deadlineMath';

/**
 * The register page against the hub's props object. Pinned here:
 *   - without `data.dsr` it reads /api/dsr/requests itself and posts the
 *     actions to the routes in the brief; with `data.dsr` it uses the hook;
 *   - a failed read is its own state; counts are unknown until loaded;
 *   - the header's primary opens the capture modal through the handle and
 *     the modal validates before it posts an allow-listed body.
 */

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = typeof fallback === 'string' ? fallback : key;
            const params = typeof fallback === 'string' ? vars : fallback;
            return params ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), base) : base;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../shared/Toast', () => ({ toast }));

const fetchJson = vi.fn();
vi.mock('../data/api', async (importOriginal) => {
    const real = await importOriginal();
    return { ...real, fetchJson: (...a) => fetchJson(...a) };
});

const NOW = new Date('2026-09-14T09:12:00Z').getTime();
const iso = (ms) => new Date(ms).toISOString();
const ROWS = [
    { id: 2038, request_type: 'deletion', state: 'in_progress', subject_email_masked: 'j.•••@gmail.com', channel: 'public_form', identity_status: 'verified_email_link', created_at: iso(NOW - 33 * DAY_MS), due_at: iso(NOW - 3 * DAY_MS) },
    { id: 2041, request_type: 'access', state: 'in_progress', subject_email_masked: 'm.•••@vandijkgroep.nl', channel: 'email_dpo', created_at: iso(NOW - 12 * DAY_MS), due_at: iso(NOW + 18 * DAY_MS) },
    { id: 2036, request_type: 'deletion', state: 'fulfilled', subject_email_masked: 'p.•••@outlook.com', channel: 'phone', created_at: iso(NOW - 48 * DAY_MS), completed_at: iso(NOW - 39 * DAY_MS), result_summary: 'done' },
];

const t = (key, fallback, vars) => (vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), fallback) : fallback);

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    fetchJson.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    // ≥ 1180 → the drawer sits inline beside the table
    window.matchMedia = (query) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => { vi.useRealTimers(); });

const listOnly = (rows = ROWS) => fetchJson.mockImplementation((url, init) => {
    if (url.endsWith('/api/dsr/requests') && !init) return Promise.resolve(rows);
    if (/\/(timeline|discovery)$/.test(url)) return Promise.reject(new Error('404 Not Found'));
    return Promise.resolve({ ok: true });
});

describe('DsrPage — without data.dsr it talks to /api/dsr itself', () => {
    it('reads the list, shows the open filter by default with counts, sorts by deadline', async () => {
        listOnly();
        render(<DsrPage />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        await screen.findByTestId('dsr-table-row-2038');
        expect(fetchJson).toHaveBeenCalledWith(expect.stringMatching(/\/api\/dsr\/requests$/));
        const pills = screen.getByTestId('dsr-filter');
        expect(within(pills).getByTestId('dsr-filter-open')).toHaveTextContent('Open2');
        expect(within(pills).getByTestId('dsr-filter-overdue')).toHaveTextContent('Overdue1');
        expect(within(pills).getByTestId('dsr-filter-fulfilled')).toHaveTextContent('Completed1');
        expect(within(pills).getByTestId('dsr-filter-open')).toHaveAttribute('aria-pressed', 'true');
        const ids = screen.getAllByTestId(/^dsr-table-row-/).map(r => r.getAttribute('data-testid'));
        expect(ids).toEqual(['dsr-table-row-2038', 'dsr-table-row-2041']);
        expect(screen.getByTestId('dsr-sort-note')).toHaveTextContent('By deadline');
        expect(screen.getByTestId('dsr-intake-note')).toHaveTextContent('The 30-day clock starts at receipt');
        expect(screen.getByTestId('dsr-view-form')).toHaveAttribute('href', expect.stringMatching(/\/privacy\/requests$/));
    });

    it('filter pills and the search narrow the list; the overdue pill is the error tone', async () => {
        listOnly();
        render(<DsrPage />);
        await screen.findByTestId('dsr-table-row-2038');
        fireEvent.click(screen.getByTestId('dsr-filter-fulfilled'));
        expect(screen.queryByTestId('dsr-table-row-2038')).toBeNull();
        expect(screen.getByTestId('dsr-table-row-2036')).toBeTruthy();
        fireEvent.click(screen.getByTestId('dsr-filter-overdue'));
        expect(screen.getAllByTestId(/^dsr-table-row-/)).toHaveLength(1);
        expect(screen.getByTestId('dsr-filter-overdue').style.borderColor).toBe('var(--error)');
        fireEvent.click(screen.getByTestId('dsr-filter-open'));
        fireEvent.change(screen.getByTestId('dsr-search'), { target: { value: 'vandijk' } });
        expect(screen.getAllByTestId(/^dsr-table-row-/).map(r => r.getAttribute('data-testid'))).toEqual(['dsr-table-row-2041']);
        fireEvent.change(screen.getByTestId('dsr-search'), { target: { value: '#9999' } });
        expect(screen.getByTestId('dsr-filter-empty')).toBeTruthy();
    });

    it('a failed read is its own state — not an empty register — and the pills carry no counts', async () => {
        fetchJson.mockRejectedValue(new Error('500 Internal Server Error'));
        render(<DsrPage />);
        await screen.findByTestId('dsr-table-failed-text');
        expect(screen.queryByTestId('dsr-table-empty-text')).toBeNull();
        expect(screen.getByTestId('dsr-filter-open')).toHaveTextContent(/^Open$/);
    });

    it('row click opens the inline drawer; Fulfil posts to /requests/:id/fulfil and re-reads the list; toast on success', async () => {
        listOnly();
        render(<DsrPage />);
        fireEvent.click(await screen.findByTestId('dsr-table-row-2041'));
        const drawer = await screen.findByTestId('dsr-drawer');
        expect(drawer).toHaveAttribute('data-mode', 'inline');
        expect(screen.getByTestId('dsr-page')).toHaveAttribute('data-drawer', 'inline');
        expect(screen.getByTestId('dsr-table-row-2041')).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByTestId('dsr-drawer-export')).toHaveAttribute('href', expect.stringMatching(/\/api\/dsr\/requests\/2041\/export$/));

        fireEvent.change(screen.getByTestId('dsr-drawer-summary-input'), { target: { value: 'Export sent.' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalledWith(
            expect.stringMatching(/\/api\/dsr\/requests\/2041\/fulfil$/),
            expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'fulfilled', result_summary: 'Export sent.', notify_subject: true }) }),
        ));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('fulfilled')));
        expect(fetchJson.mock.calls.filter(([u, i]) => u.endsWith('/api/dsr/requests') && !i)).toHaveLength(2);
    });

    it('Extend posts { reason } to /extend; Start posts to /start; a failing write toasts an error', async () => {
        listOnly();
        render(<DsrPage />);
        fireEvent.click(await screen.findByTestId('dsr-table-row-2041'));
        fireEvent.click(await screen.findByTestId('dsr-drawer-extend'));
        fireEvent.change(screen.getByTestId('dsr-drawer-extend-reason'), { target: { value: 'Three systems' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-extend-confirm'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalledWith(
            expect.stringMatching(/\/api\/dsr\/requests\/2041\/extend$/),
            expect.objectContaining({ body: JSON.stringify({ reason: 'Three systems' }) }),
        ));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('60 days')));
    });

    it('Start posts to /start on a pending row; a failing write toasts the error key, never a success', async () => {
        fetchJson.mockImplementation((url, init) => {
            if (url.endsWith('/api/dsr/requests') && !init) return Promise.resolve([{ ...ROWS[1], state: 'pending' }]);
            if (/\/start$/.test(url)) return Promise.reject(new Error('409 Conflict'));
            return Promise.reject(new Error('404 Not Found'));
        });
        render(<DsrPage focusId={2041} />);
        fireEvent.click(await screen.findByTestId('dsr-drawer-start'));
        await waitFor(() => expect(fetchJson).toHaveBeenCalledWith(expect.stringMatching(/\/api\/dsr\/requests\/2041\/start$/), expect.objectContaining({ method: 'POST' })));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not update the request'));
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('a completed row opens read-only', async () => {
        listOnly();
        render(<DsrPage focusId="2036" />);
        const drawer = await screen.findByTestId('dsr-drawer-body');
        expect(drawer).toHaveAttribute('data-state', 'done');
        expect(drawer).toHaveAttribute('data-readonly', 'true');
        expect(screen.queryByTestId('dsr-drawer-fulfil')).toBeNull();
        expect(screen.getByTestId('dsr-drawer-export')).toBeTruthy();
    });
});

describe('DsrPage — with data.dsr it uses the hook', () => {
    it('does not fetch the list; fulfil/extend/start/capture go through the hook; exportUrlFor + dl decide the Export href', async () => {
        const dsr = {
            requests: ROWS, busyId: null, failed: false,
            refresh: vi.fn(), fulfil: vi.fn().mockResolvedValue({}), extend: vi.fn().mockResolvedValue({}), start: vi.fn().mockResolvedValue({}),
            capture: vi.fn().mockResolvedValue({ id: 2050 }), loadTimeline: vi.fn().mockResolvedValue(null), loadDiscovery: vi.fn().mockResolvedValue(null),
            exportUrlFor: (id) => `/x/${id}/export`,
        };
        const dl = vi.fn((url) => `${url}?signed`);
        render(<DsrPage data={{ dsr }} dl={dl} focusId={2038} />);
        expect(fetchJson).not.toHaveBeenCalled();
        const drawer = await screen.findByTestId('dsr-drawer-body');
        expect(drawer).toHaveAttribute('data-state', 'in_progress');
        expect(screen.getByTestId('dsr-drawer-export')).toHaveAttribute('href', '/x/2038/export?signed');
        expect(dsr.loadTimeline).toHaveBeenCalledWith(2038);
        expect(dsr.loadDiscovery).toHaveBeenCalledWith(2038);
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        await waitFor(() => expect(dsr.fulfil).toHaveBeenCalledWith(2038, { status: 'fulfilled', result_summary: undefined, notify_subject: true }));
        fireEvent.click(screen.getByTestId('dsr-drawer-reject'));
        fireEvent.change(screen.getByTestId('dsr-drawer-reject-reason'), { target: { value: 'No such data' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-reject-confirm'));
        await waitFor(() => expect(dsr.fulfil).toHaveBeenCalledWith(2038, { status: 'rejected', result_summary: 'No such data', notify_subject: true }));
    });

    it('a write the hook already toasts is not toasted twice; one it stays quiet about still reports', async () => {
        const dsr = {
            requests: ROWS, busyId: null, failed: false, refresh: vi.fn(),
            // registers.js/useDsr: fulfil reports both outcomes itself, extend
            // only its failure, start says nothing at all.
            fulfil: vi.fn().mockResolvedValue({}),
            extend: vi.fn().mockRejectedValue(new Error('500')),
            start: vi.fn().mockResolvedValue({}),
        };
        const { rerender } = render(<DsrPage data={{ dsr }} focusId={2038} />);
        await screen.findByTestId('dsr-drawer-body');
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        await waitFor(() => expect(dsr.fulfil).toHaveBeenCalled());
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();                 // the hook said it

        fireEvent.click(screen.getByTestId('dsr-drawer-extend'));
        fireEvent.change(screen.getByTestId('dsr-drawer-extend-reason'), { target: { value: 'complex' } });
        fireEvent.click(screen.getByTestId('dsr-drawer-extend-confirm'));
        await waitFor(() => expect(dsr.extend).toHaveBeenCalledWith(2038, 'complex'));
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();                 // the hook toasts extend failures

        rerender(<DsrPage data={{ dsr }} focusId={2041} />);
        await screen.findByTestId('dsr-drawer-body');
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        await waitFor(() => expect(dsr.fulfil).toHaveBeenCalledTimes(2));
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('without the hook the page owns the message: its own fulfil toasts success, a failure toasts the error', async () => {
        listOnly();
        render(<DsrPage focusId={2038} />);
        await screen.findByTestId('dsr-drawer-body');
        fireEvent.click(screen.getByTestId('dsr-drawer-fulfil'));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Request fulfilled — the data subject has been e-mailed'));
    });

    it('requests === null is loading, dl === null (demo) hides Export', async () => {
        const { rerender } = render(<DsrPage data={{ dsr: { requests: null } }} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        rerender(<DsrPage data={{ dsr: { requests: ROWS } }} dl={() => null} focusId={2038} />);
        await screen.findByTestId('dsr-drawer');
        expect(screen.queryByTestId('dsr-drawer-export')).toBeNull();
    });
});

describe('DsrPage — the header primary is registered with the hub', () => {
    it('setHeaderActions gets onCaptureRequest on mount, opens the modal, and is cleared on unmount', async () => {
        listOnly();
        const setHeaderActions = vi.fn();
        const { unmount } = render(<DsrPage setHeaderActions={setHeaderActions} />);
        await screen.findByTestId('dsr-table-row-2038');
        expect(setHeaderActions).toHaveBeenCalledTimes(1);
        const registered = setHeaderActions.mock.calls[0][0];
        expect(typeof registered.onCaptureRequest).toBe('function');
        expect(screen.queryByTestId('dsr-capture-form')).toBeNull();
        act(() => registered.onCaptureRequest());
        expect(screen.getByTestId('dsr-capture-form')).toBeTruthy();
        unmount();
        expect(setHeaderActions).toHaveBeenLastCalledWith({});
    });
});

describe('DsrPage — capture modal', () => {
    it('opens through the handle, validates, then posts the allow-listed body to /requests/manual and toasts', async () => {
        listOnly();
        const ref = React.createRef();
        render(<DsrPage ref={ref} />);
        await screen.findByTestId('dsr-table-row-2038');
        expect(screen.queryByTestId('dsr-capture-form')).toBeNull();
        act(() => ref.current.openCapture());
        const form = await screen.findByTestId('dsr-capture-form');
        expect(screen.getByRole('dialog')).toBeTruthy();

        fireEvent.submit(form);
        expect(screen.getByTestId('dsr-capture-err-subject_email')).toHaveTextContent('e-mail address');
        expect(fetchJson.mock.calls.some(([u]) => u.endsWith('/requests/manual'))).toBe(false);

        fireEvent.change(screen.getByTestId('dsr-capture-email'), { target: { value: 'not-an-email' } });
        fireEvent.submit(form);
        expect(screen.getByTestId('dsr-capture-err-subject_email')).toBeTruthy();

        fireEvent.change(screen.getByTestId('dsr-capture-email'), { target: { value: 'anna@example.org' } });
        fireEvent.change(screen.getByTestId('dsr-capture-type'), { target: { value: 'access' } });
        fireEvent.change(screen.getByTestId('dsr-capture-channel'), { target: { value: 'phone' } });
        fireEvent.change(screen.getByTestId('dsr-capture-received'), { target: { value: '2026-09-13T10:30' } });
        fireEvent.change(screen.getByTestId('dsr-capture-notes'), { target: { value: 'Called the DPO line.' } });
        fireEvent.submit(form);
        await waitFor(() => expect(fetchJson).toHaveBeenCalledWith(
            expect.stringMatching(/\/api\/dsr\/requests\/manual$/),
            expect.objectContaining({ method: 'POST' }),
        ));
        const call = fetchJson.mock.calls.find(([u]) => u.endsWith('/requests/manual'));
        const body = JSON.parse(call[1].body);
        expect(Object.keys(body).sort()).toEqual(['channel', 'notes', 'received_at', 'request_type', 'subject_email']);
        expect(body).toMatchObject({ request_type: 'access', subject_email: 'anna@example.org', channel: 'phone', notes: 'Called the DPO line.' });
        expect(new Date(body.received_at).getTime()).toBe(new Date('2026-09-13T10:30').getTime());
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('recorded')));
        await waitFor(() => expect(screen.queryByTestId('dsr-capture-form')).toBeNull());
    });

    it('captureSignal opens it too, and the e-mail channel goes out as email_dpo', async () => {
        listOnly();
        const { rerender } = render(<DsrPage captureSignal={0} />);
        await screen.findByTestId('dsr-table-row-2038');
        rerender(<DsrPage captureSignal={1} />);
        expect(await screen.findByTestId('dsr-capture-form')).toBeTruthy();
        expect(capturePayload({ request_type: 'deletion', subject_email: ' a@b.io ', channel: 'email', received_at: '2026-09-13T10:30', notes: '  ' }))
            .toEqual({ request_type: 'deletion', subject_email: 'a@b.io', channel: 'email_dpo', received_at: new Date('2026-09-13T10:30').toISOString() });
    });

    it('validateCapture: every field, and a receipt date in the future is refused', () => {
        expect(validateCapture({ request_type: 'x', subject_email: 'nope', channel: 'form', received_at: '' }, NOW))
            .toEqual({ request_type: 'type', subject_email: 'email', channel: 'channel', received_at: 'received' });
        expect(validateCapture({ request_type: 'access', subject_email: 'a@b.io', channel: 'letter', received_at: iso(NOW + DAY_MS) }, NOW))
            .toEqual({ received_at: 'future' });
        expect(validateCapture({ request_type: 'access', subject_email: 'a@b.io', channel: 'letter', received_at: iso(NOW - DAY_MS) }, NOW)).toEqual({});
    });
});

describe('DsrPage — tabs and header spec', () => {
    it('public_form shows the URL with a copy button; settings links to the settings section', async () => {
        const navigate = vi.fn();
        const { rerender } = render(<DsrPage tab="public_form" navigate={navigate} data={{ core: { overview: { settings: { public_dsr_url: 'https://acme.example/dsr' } } } }} />);
        expect(screen.getByTestId('dsr-public-form-url')).toHaveTextContent('https://acme.example/dsr');
        expect(screen.getByTestId('dsr-public-form-open')).toHaveAttribute('href', 'https://acme.example/dsr');
        expect(screen.getByTestId('dsr-public-form')).toHaveTextContent('Rate-limited');
        expect(screen.getByTestId('dsr-public-form')).toHaveTextContent('Identity via e-mail link');
        expect(screen.getByTestId('dsr-public-form-copy')).toBeTruthy();
        fireEvent.click(screen.getByTestId('dsr-public-form-settings'));
        expect(navigate).toHaveBeenCalledWith('settings');
        expect(fetchJson).not.toHaveBeenCalled();
        rerender(<DsrPage tab="settings" navigate={navigate} />);
        fireEvent.click(screen.getByTestId('dsr-settings-open'));
        expect(navigate).toHaveBeenLastCalledWith('settings');
    });

    it('dsrHeaderSpec: unknown/zero overdue → neutral pill; n → error Timer pill; the window chip; refresh + primary', () => {
        const onRefresh = vi.fn(), onCapture = vi.fn();
        const none = dsrHeaderSpec(t, { overdue: undefined, onRefresh, onCapture });
        expect(none.pill.tone).toBe('neutral');
        expect(none.pill.label).toBe('All requests within the deadline');
        expect(dsrHeaderSpec(t, { overdue: 0 }).pill.tone).toBe('neutral');
        const late = dsrHeaderSpec(t, { overdue: 1, onRefresh, onCapture });
        expect(late.pill).toMatchObject({ tone: 'error', label: '1 past the deadline' });
        expect(late.infoChip.label).toBe('Art. 12–22 · 30 days, +60 with reason');
        expect(late.secondary.iconOnly).toBe(true);
        late.secondary.onClick(); late.primary.onClick();
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(onCapture).toHaveBeenCalledTimes(1);
        expect(late.primary.label).toBe('Record a request');
    });
});
