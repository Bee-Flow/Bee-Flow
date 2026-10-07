import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countByFilter, matchesQuery, sortByDeadline } from './dsrArticles';
import DsrTable, { formatReceived, shownEmailOf } from './DsrTable';
import { DAY_MS } from '../../../../shared/deadlineMath';

/**
 * Artboard 1c's table: the clock is the first column, the list never shows a
 * full e-mail address, closed rows read "completed in n days".
 */

vi.mock('../../../../../hooks/useTranslation', () => {
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

const NOW = new Date('2026-09-14T09:12:00Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

const ROWS = [
    // overdue by 2 days: received 12 Aug, no server due_at → + one calendar month = 12 Sep (Art. 12(3))
    { id: 2038, request_type: 'deletion', status: 'in_progress', subject_email: 'john.doe@gmail.com', channel: 'public_form', identity_status: 'verified_email_link', created_at: iso(NOW - 33 * DAY_MS) },
    // 18 days left: server due_at wins
    { id: 2041, request_type: 'access', state: 'in_progress', subject_email_masked: 'm.•••@vandijkgroep.nl', channel: 'email_dpo', identity_status: 'employee', created_at: iso(NOW - 12 * DAY_MS), due_at: iso(NOW + 18 * DAY_MS) },
    // open, received today
    { id: 2044, request_type: 'portability', status: 'pending', subject_email: 'anna@vandijkgroep.nl', channel: 'form', created_at: iso(NOW - 20 * 60_000) },
    // completed in 9 days
    { id: 2036, request_type: 'deletion', status: 'fulfilled', subject_email: 'p.q@outlook.com', channel: 'phone', created_at: iso(NOW - 48 * DAY_MS), completed_at: iso(NOW - 39 * DAY_MS), result_summary: '2 memories and 6 rows deleted' },
    { id: 2030, request_type: 'objection', status: 'rejected', subject_email: 'k@ziggo.nl', channel: 'letter', created_at: iso(NOW - 60 * DAY_MS), updated_at: iso(NOW - 58 * DAY_MS) },
];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('DsrTable — the clock column', () => {
    it('open rows count down from receipt + one calendar month (or the server due_at); overdue rows say so in error ink', () => {
        render(<DsrTable rows={ROWS} />);
        const late = screen.getByTestId('dsr-table-clock-2038');
        expect(late).toHaveAttribute('data-state', 'overdue');
        expect(late).toHaveTextContent('overdue by 2 days');
        expect(late).toHaveAttribute('data-tone', 'error');
        const ok = screen.getByTestId('dsr-table-clock-2041');
        expect(ok).toHaveAttribute('data-state', 'ok');
        expect(ok).toHaveTextContent('18 days left');
        expect(screen.getByTestId('dsr-table-clock-2041-bar')).toBeTruthy();
    });

    it('a request received minutes ago is urgent only under five days — this one is ok and reads "today HH:mm"', () => {
        render(<DsrTable rows={ROWS} />);
        expect(screen.getByTestId('dsr-table-clock-2044')).toHaveAttribute('data-state', 'ok');
        expect(within(screen.getByTestId('dsr-table-row-2044')).getByText(/^today \d{2}:\d{2}$/)).toBeTruthy();
    });

    it('completed rows show "completed in n days", draw no bar and read in tertiary text', () => {
        render(<DsrTable rows={ROWS} />);
        const done = screen.getByTestId('dsr-table-clock-2036');
        expect(done).toHaveAttribute('data-state', 'done');
        expect(done).toHaveTextContent('completed in 9 days');
        expect(screen.queryByTestId('dsr-table-clock-2036-bar')).toBeNull();
        expect(screen.getByTestId('dsr-table-row-2036').className).toContain('text-[var(--text-tertiary)]');
        // a rejected row without completed_at falls back to updated_at
        expect(screen.getByTestId('dsr-table-clock-2030')).toHaveTextContent('completed in 2 days');
    });
});

describe('DsrTable — the list never holds a full address (BFSF-441)', () => {
    it('masks subject_email and passes an already-masked subject_email_masked through', () => {
        const { container } = render(<DsrTable rows={ROWS} />);
        expect(container.textContent).not.toContain('john.doe@gmail.com');
        expect(container.textContent).not.toContain('anna@vandijkgroep.nl');
        expect(container.innerHTML).not.toContain('john.doe@');
        expect(within(screen.getByTestId('dsr-table-row-2038')).getByTestId('dsr-row-subject')).toHaveTextContent('j.•••@gmail.com · identity confirmed');
        expect(within(screen.getByTestId('dsr-table-row-2041')).getByTestId('dsr-row-subject')).toHaveTextContent('m.•••@vandijkgroep.nl · employee');
        expect(within(screen.getByTestId('dsr-table-row-2044')).getByTestId('dsr-row-subject')).toHaveTextContent('a.•••@vandijkgroep.nl · identity unknown');
    });

    it('shownEmailOf is the only e-mail path and is idempotent on masked input', () => {
        expect(shownEmailOf({ subject_email: 'john.doe@gmail.com' })).toBe('j.•••@gmail.com');
        expect(shownEmailOf({ subject_email_masked: 'j.•••@gmail.com', subject_email: 'john.doe@gmail.com' })).toBe('j.•••@gmail.com');
        expect(shownEmailOf({})).toBe('•••');
    });

    it('a closed row shows the result summary on its second line instead of the address', () => {
        render(<DsrTable rows={ROWS} />);
        expect(within(screen.getByTestId('dsr-table-row-2036')).getByTestId('dsr-row-subject')).toHaveTextContent('2 memories and 6 rows deleted');
    });
});

describe('DsrTable — request, channel and status cells', () => {
    it('#id mono · type label · Art. n from the article map; channel icon+label; status pill per state', () => {
        render(<DsrTable rows={ROWS} />);
        const row = screen.getByTestId('dsr-table-row-2038');
        expect(row).toHaveTextContent('#2038');
        expect(row).toHaveTextContent('Deletion request');
        expect(row).toHaveTextContent('Art. 17');
        expect(within(row).getByText('Form /dsr').closest('[data-channel]')).toHaveAttribute('data-channel', 'form');
        expect(screen.getByTestId('dsr-table-state-2038')).toHaveTextContent('In progress');
        expect(screen.getByTestId('dsr-table-state-2038')).toHaveAttribute('data-state', 'in_progress');

        expect(screen.getByTestId('dsr-table-row-2041')).toHaveTextContent('Art. 15');
        expect(within(screen.getByTestId('dsr-table-row-2041')).getByText('E-mail to DPO')).toBeTruthy();

        // One look for every register (RegisterStatePill): never dashed, urgency stays with the clock.
        expect(screen.getByTestId('dsr-table-state-2038')).toHaveAttribute('data-tone', 'warning');
        const pending = screen.getByTestId('dsr-table-state-2044');
        expect(pending).toHaveTextContent('Open');
        expect(pending).toHaveAttribute('data-tone', 'neutral');
        expect(pending.className).not.toContain('dashed');

        const done = screen.getByTestId('dsr-table-state-2036');
        expect(done).toHaveTextContent('Completed');
        expect(done).toHaveAttribute('data-tone', 'success');
        expect(done.className).toContain('text-[var(--success-ink)]');
        expect(screen.getByTestId('dsr-table-state-2030')).toHaveAttribute('data-tone', 'muted');
        expect(within(screen.getByTestId('dsr-table-row-2036')).getByText('Phone')).toBeTruthy();

        expect(screen.getByTestId('dsr-table-state-2030')).toHaveTextContent('Rejected');
        expect(within(screen.getByTestId('dsr-table-row-2030')).getByText('Letter')).toBeTruthy();
        expect(screen.getByTestId('dsr-table-row-2030')).toHaveTextContent('Art. 21');
    });

    it('the header is the artboard: Deadline · Request · Received · Via · Status on 118px 1fr 104px 110px 96px', () => {
        render(<DsrTable rows={ROWS} />);
        const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
        expect(headers).toEqual(['Deadline ↓', 'Request', 'Received', 'Via', 'Status']);
        const headerRow = screen.getAllByRole('row')[0];
        expect(headerRow.style.getPropertyValue('--ct-cols')).toBe('118px 1fr 104px 110px 96px');
    });

    it('the register is sorted by deadline, and the Deadline header says so (aria-sort, not a separate note)', () => {
        render(<DsrTable rows={ROWS} />);
        const [deadline, ...rest] = screen.getAllByRole('columnheader');
        expect(deadline).toHaveAttribute('aria-sort', 'ascending');
        expect(rest.every(h => !h.hasAttribute('aria-sort'))).toBe(true);
    });

    it('the row stripe follows the clock only: red when overdue, none for an open row with time left or a closed one', () => {
        render(<DsrTable rows={ROWS} />);
        expect(screen.getByTestId('dsr-table-row-2038')).toHaveAttribute('data-accent', 'error');
        expect(screen.getByTestId('dsr-table-row-2041')).not.toHaveAttribute('data-accent');
        expect(screen.getByTestId('dsr-table-row-2036')).not.toHaveAttribute('data-accent');
    });
});

describe('DsrTable — selection, cards, states', () => {
    it('clicking a row selects it; the selected row is aria-selected with the kind stripe', () => {
        const onSelect = vi.fn();
        const { rerender } = render(<DsrTable rows={ROWS} onSelect={onSelect} />);
        fireEvent.click(screen.getByTestId('dsr-table-row-2041'));
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2041 }));
        rerender(<DsrTable rows={ROWS} onSelect={onSelect} selectedId="2041" />);
        const row = screen.getByTestId('dsr-table-row-2041');
        expect(row).toHaveAttribute('aria-selected', 'true');
        expect(row.style.boxShadow).toContain('var(--kind-compliance)');
        expect(screen.getByTestId('dsr-table-row-2038')).not.toHaveAttribute('aria-selected');
    });

    it('mobile renders cards: clock at the right, request lines left, tap selects', () => {
        const onSelect = vi.fn();
        render(<DsrTable rows={ROWS} isMobile onSelect={onSelect} />);
        expect(screen.getByTestId('dsr-table')).toHaveAttribute('data-view', 'cards');
        const card = screen.getByTestId('dsr-table-card-2038');
        expect(card).toHaveTextContent('#2038');
        expect(within(card).getByTestId('dsr-table-clock-2038')).toHaveTextContent('overdue by 2 days');
        expect(card.textContent).not.toContain('john.doe@gmail.com');
        fireEvent.click(card);
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2038 }));
    });

    it('loading → skeleton rows; failed → its own line (never an empty list); empty → the empty line', () => {
        const { rerender } = render(<DsrTable rows={[]} loading />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('dsr-table-empty-text')).toBeNull();
        rerender(<DsrTable rows={ROWS} failed />);
        expect(screen.getByTestId('dsr-table-failed-text')).toHaveTextContent('could not be read');
        expect(screen.queryByTestId('dsr-table-row-2038')).toBeNull();
        rerender(<DsrTable rows={[]} />);
        expect(screen.getByTestId('dsr-table-empty-text')).toHaveTextContent('No data-subject requests received.');
    });
});

describe('dsrArticles — filters, sort, search', () => {
    it('counts per pill: open = pending + in_progress, overdue counted separately', () => {
        expect(countByFilter(ROWS, NOW)).toEqual({ open: 3, overdue: 1, fulfilled: 1, rejected: 1 });
    });

    it('server-shaped rows (`status` + the clock as `state`) count as Completed / Rejected, not as Open', () => {
        const server = [
            { id: 1, status: 'fulfilled', state: 'none', created_at: iso(NOW - 40 * DAY_MS), due_at: iso(NOW - 10 * DAY_MS), fulfilled_at: iso(NOW - 20 * DAY_MS) },
            { id: 2, status: 'rejected', state: 'none', created_at: iso(NOW - 48 * DAY_MS), due_at: iso(NOW - 18 * DAY_MS), fulfilled_at: iso(NOW - 40 * DAY_MS) },
            { id: 3, status: 'in_progress', state: 'urgent', created_at: iso(NOW - 27 * DAY_MS), due_at: iso(NOW + 3 * DAY_MS) },
        ];
        expect(countByFilter(server, NOW)).toEqual({ open: 1, overdue: 0, fulfilled: 1, rejected: 1 });
        render(<DsrTable rows={server} />);
        expect(screen.getByTestId('dsr-table-state-2')).toHaveTextContent('Rejected');
        expect(screen.getByTestId('dsr-table-clock-2')).toHaveAttribute('data-state', 'done');
        expect(screen.getByTestId('dsr-table-row-3')).toHaveAttribute('data-accent', 'warning');
    });

    it('by deadline: open rows soonest first (overdue on top), closed rows after, newest first', () => {
        expect(sortByDeadline(ROWS).map(r => r.id)).toEqual([2038, 2041, 2044, 2036, 2030]);
    });

    it('search matches the number (with or without #) and the masked address or its domain — never data we do not show', () => {
        const row = ROWS[0];
        const shown = shownEmailOf(row);
        expect(matchesQuery(row, '#2038', shown)).toBe(true);
        expect(matchesQuery(row, '2038', shown)).toBe(true);
        expect(matchesQuery(row, 'gmail', shown)).toBe(true);
        expect(matchesQuery(row, 'j.•••', shown)).toBe(true);
        expect(matchesQuery(row, 'john', shown)).toBe(false);
        expect(matchesQuery(row, '', shown)).toBe(true);
    });

    it('formatReceived: today → "today HH:mm", otherwise "d MMM", other years add the year', () => {
        const t = (k, f, v) => Object.entries(v || {}).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f);
        expect(formatReceived(t, NOW - 5 * 60_000, NOW, 'en')).toMatch(/^today \d{2}:\d{2}$/);
        expect(formatReceived(t, NOW - 33 * DAY_MS, NOW, 'en')).toBe('12 Aug');
        expect(formatReceived(t, NOW - 400 * DAY_MS, NOW, 'en')).toMatch(/'25$/);
        expect(formatReceived(t, null, NOW, 'en')).toBe('');
    });
});
