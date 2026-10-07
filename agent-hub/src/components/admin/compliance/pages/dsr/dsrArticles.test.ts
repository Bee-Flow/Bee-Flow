// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../../../../shared/deadlineMath';
import { clockPropsOf, countByFilter, isClosed, isOpen, isOverdue, matchesFilter, stateOf } from './dsrArticles';

/**
 * The lifecycle state of a request comes from `status`. The server's list row
 * ALSO carries a `state`, but that one is the CLOCK (ok · urgent · overdue ·
 * none, routes/dsr.js listRow); reading it first made every request 'pending',
 * so rejected and fulfilled requests showed as Open and "overdue by 19 days".
 */

const NOW = new Date('2026-10-06T09:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** Rows exactly as GET /api/dsr/requests sends them: `status` + the clock `state`. */
const SERVER_ROWS = [
    { id: 2417, status: 'in_progress', state: 'urgent', created_at: iso(NOW - 27 * DAY_MS), due_at: iso(NOW + 3 * DAY_MS) },
    { id: 2416, status: 'pending', state: 'ok', created_at: iso(NOW - 9 * DAY_MS), due_at: iso(NOW + 21 * DAY_MS) },
    { id: 2415, status: 'fulfilled', state: 'none', created_at: iso(NOW - 34 * DAY_MS), due_at: iso(NOW - 4 * DAY_MS), fulfilled_at: iso(NOW - 21 * DAY_MS) },
    { id: 2414, status: 'rejected', state: 'none', created_at: iso(NOW - 48 * DAY_MS), due_at: iso(NOW - 18 * DAY_MS), fulfilled_at: iso(NOW - 40 * DAY_MS) },
    { id: 2413, status: 'fulfilled', state: 'none', created_at: iso(NOW - 61 * DAY_MS), due_at: iso(NOW + 29 * DAY_MS), fulfilled_at: iso(NOW - 38 * DAY_MS) },
];

describe('dsrArticles.stateOf: the lifecycle state, never the clock', () => {
    it('reads `status` when the server also sends the clock as `state`', () => {
        expect(stateOf({ status: 'rejected', state: 'none' })).toBe('rejected');
        expect(stateOf({ status: 'in_progress', state: 'urgent' })).toBe('in_progress');
        expect(stateOf({ status: 'fulfilled', state: 'overdue' })).toBe('fulfilled');
        expect(stateOf({ status: 'pending', state: 'ok' })).toBe('pending');
    });

    it('still reads a lifecycle word in `state` (older rows), and falls back to pending', () => {
        expect(stateOf({ state: 'in_progress' })).toBe('in_progress');
        expect(stateOf({ state: 'fulfilled' })).toBe('fulfilled');
        expect(stateOf({ state: 'urgent' })).toBe('pending');
        expect(stateOf({ status: 'bogus' })).toBe('pending');
        expect(stateOf(null)).toBe('pending');
    });

    it('a rejected or fulfilled server row is closed, so its clock stops and it is never overdue', () => {
        const rejected = SERVER_ROWS[3];
        expect(isClosed(rejected)).toBe(true);
        expect(isOpen(rejected)).toBe(false);
        expect(isOverdue(rejected, NOW)).toBe(false);
        expect(clockPropsOf(rejected)).toMatchObject({ state: 'done', doneAt: NOW - 40 * DAY_MS });
        expect(isClosed(SERVER_ROWS[2])).toBe(true);
        expect(isClosed(SERVER_ROWS[0])).toBe(false);
    });

    it('the filter counts of the demo register: Open 2 · Overdue 0 · Completed 2 · Rejected 1', () => {
        expect(countByFilter(SERVER_ROWS, NOW)).toEqual({ open: 2, overdue: 0, fulfilled: 2, rejected: 1 });
        expect(SERVER_ROWS.filter((r) => matchesFilter(r, 'open', NOW)).map((r) => r.id)).toEqual([2417, 2416]);
    });
});
