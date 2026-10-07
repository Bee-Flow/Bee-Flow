// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    CLOCK_STATES, DAY_MS, DAYS_WINDOW_MS, HOUR_MS, OVERDUE_IN_DAYS_AFTER_MS,
    clockState, isClockState, normalisePct, toMs,
} from './deadlineMath';

/**
 * The one clock behind every compliance deadline. The table below is the
 * contract the row clock, the drawer block, the rail meta and the header pill
 * all render from — a change here is a change on four surfaces at once.
 *
 * Fixtures follow artboard 1a/1c (today = 14 Sep 2026): #2038 received 12 Aug
 * 14:02 is "3 dagen te laat"; #2041 due 2 Oct is "nog 18 dagen"; INC-7's
 * 72-hour clock from 13 Sep 16:04 reads "nog 41 uur"; #2037 was "afgerond in
 * 18 dagen".
 */
const T = (iso) => new Date(iso).getTime();
const NOW = T('2026-09-14T09:12:00Z');

describe('clockState — the 30-day DSR clock (days)', () => {
    const started = '2026-08-12T14:02:00Z';
    const due = '2026-09-11T14:02:00Z';

    it('#2038: 2 d 19 h past the due date reads as 3 days overdue, bar full', () => {
        const c = clockState({ dueAt: due, startedAt: started, now: NOW, urgentBelowMs: 5 * DAY_MS });
        expect(c.state).toBe('overdue');
        expect(c.unit).toBe('days');
        expect(c.value).toBe(3);
        expect(c.overdueValue).toBe(3);
        expect(c.pct).toBe(1);
        expect(c.remainingMs).toBeLessThan(0);
    });

    it('#2041: 18 days left on a 30-day window is ok, bar at elapsed share', () => {
        const s = '2026-09-02T09:12:00Z';
        const d = '2026-10-02T09:12:00Z';
        const c = clockState({ dueAt: d, startedAt: s, now: NOW, urgentBelowMs: 5 * DAY_MS });
        expect(c.state).toBe('ok');
        expect(c.unit).toBe('days');
        expect(c.value).toBe(18);
        expect(c.overdueValue).toBe(0);
        expect(c.pct).toBeCloseTo(12 / 30, 5);
    });

    it('rounds the remaining time UP: 17 d 6 h left is "18 days left", not 17', () => {
        const d = NOW + 17 * DAY_MS + 6 * HOUR_MS;
        const c = clockState({ dueAt: d, startedAt: NOW - 13 * DAY_MS, now: NOW });
        expect(c.value).toBe(18);
    });

    it('turns urgent at the caller\'s threshold (DSR: 5 days), not before', () => {
        const s = NOW - 25 * DAY_MS;
        const justOver = clockState({ dueAt: NOW + 5 * DAY_MS + 1, startedAt: s, now: NOW, urgentBelowMs: 5 * DAY_MS });
        const atLimit = clockState({ dueAt: NOW + 5 * DAY_MS, startedAt: s, now: NOW, urgentBelowMs: 5 * DAY_MS });
        expect(justOver.state).toBe('ok');
        expect(atLimit.state).toBe('urgent');
        expect(atLimit.value).toBe(5);
    });

    it('without a threshold nothing is ever urgent — only ok or overdue', () => {
        const c = clockState({ dueAt: NOW + HOUR_MS, startedAt: NOW - 29 * DAY_MS, now: NOW });
        expect(c.state).toBe('ok');
    });

    it('a +60 d extension is simply a later due date on the same start: 90-day window, still days', () => {
        const s = '2026-07-01T10:00:00Z';
        const extended = '2026-09-29T10:00:00Z'; // 30 d + 60 d
        const c = clockState({ dueAt: extended, startedAt: s, now: NOW, urgentBelowMs: 5 * DAY_MS });
        expect(c.state).toBe('ok');
        expect(c.unit).toBe('days');
        expect(c.value).toBe(16);
        expect(c.pct).toBeCloseTo(75 / 90, 3);
    });
});

describe('clockState — the 72 h / 24 h incident clocks (hours)', () => {
    it('INC-7: 72 h from 13 Sep 16:04, 41 h left at 14 Sep 23:04, urgent below 24 h → still ok', () => {
        const s = '2026-09-13T16:04:00Z';
        const d = '2026-09-16T16:04:00Z';
        const now = T('2026-09-14T23:04:00Z');
        const c = clockState({ dueAt: d, startedAt: s, now, urgentBelowMs: 24 * HOUR_MS });
        expect(c.unit).toBe('hours');
        expect(c.value).toBe(41);
        expect(c.state).toBe('ok');
        expect(c.pct).toBeCloseTo(31 / 72, 4);
    });

    it('the same clock with 20 h left is urgent (≤ 24 h)', () => {
        const s = NOW - 52 * HOUR_MS;
        const c = clockState({ dueAt: s + 72 * HOUR_MS, startedAt: s, now: NOW, urgentBelowMs: 24 * HOUR_MS });
        expect(c.state).toBe('urgent');
        expect(c.value).toBe(20);
    });

    it('a CRA 24-hour early warning: 6 h threshold, 5 h 30 left → urgent, "6 hours"', () => {
        const s = NOW - 18.5 * HOUR_MS;
        const c = clockState({ dueAt: s + 24 * HOUR_MS, startedAt: s, now: NOW, urgentBelowMs: 6 * HOUR_MS });
        expect(c.unit).toBe('hours');
        expect(c.state).toBe('urgent');
        expect(c.value).toBe(6);
    });

    it('overdue by 90 minutes reads as 2 hours overdue, bar full', () => {
        const s = NOW - 73.5 * HOUR_MS;
        const c = clockState({ dueAt: s + 72 * HOUR_MS, startedAt: s, now: NOW, urgentBelowMs: 24 * HOUR_MS });
        expect(c.state).toBe('overdue');
        expect(c.value).toBe(2);
        expect(c.overdueValue).toBe(2);
        expect(c.pct).toBe(1);
    });

    it('an hours clock more than 48 h overdue counts in days ("overdue by 31 days", not 745 hours)', () => {
        expect(OVERDUE_IN_DAYS_AFTER_MS).toBe(48 * HOUR_MS);
        const s = NOW - 72 * HOUR_MS - 31 * DAY_MS + HOUR_MS;
        const late = clockState({ dueAt: s + 72 * HOUR_MS, startedAt: s, now: NOW });
        expect(late.state).toBe('overdue');
        expect(late.unit).toBe('days');
        expect(late.value).toBe(31);
        expect(late.overdueValue).toBe(31);
    });

    it('up to 48 h overdue it keeps counting hours; past it, days (rounded up)', () => {
        const start = (lateMs) => NOW - lateMs - 72 * HOUR_MS;
        const at48 = clockState({ dueAt: start(48 * HOUR_MS) + 72 * HOUR_MS, startedAt: start(48 * HOUR_MS), now: NOW });
        expect(at48.unit).toBe('hours');
        expect(at48.value).toBe(48);
        const justOver = clockState({ dueAt: start(48 * HOUR_MS + 1) + 72 * HOUR_MS, startedAt: start(48 * HOUR_MS + 1), now: NOW });
        expect(justOver.unit).toBe('days');
        expect(justOver.value).toBe(3);
    });

    it('an explicit unit: hours keeps its hours however late', () => {
        const s = NOW - 10 * DAY_MS;
        const c = clockState({ dueAt: s + 72 * HOUR_MS, startedAt: s, now: NOW, unit: 'hours' });
        expect(c.unit).toBe('hours');
        expect(c.value).toBe(7 * 24);
    });

    it('the unit rule sits exactly at 7 days: a 7-day window counts in days, 6 d 23 h in hours', () => {
        const week = clockState({ dueAt: NOW + DAYS_WINDOW_MS, startedAt: NOW, now: NOW });
        const short = clockState({ dueAt: NOW + DAYS_WINDOW_MS - HOUR_MS, startedAt: NOW, now: NOW });
        expect(week.unit).toBe('days');
        expect(short.unit).toBe('hours');
    });
});

describe('clockState — done, none, unknown start', () => {
    it('#2037: fulfilled → done, completed in whole days (ceil), the due date no longer matters', () => {
        const c = clockState({
            dueAt: '2026-09-02T10:00:00Z', startedAt: '2026-08-03T10:00:00Z', doneAt: '2026-08-21T09:00:00Z', now: NOW,
        });
        expect(c.state).toBe('done');
        expect(c.completedInDays).toBe(18);
        expect(c.value).toBe(18);
        expect(c.pct).toBe(1);
        expect(c.overdueValue).toBe(0);
    });

    it('closed the same day it was opened counts as 1 day, never 0', () => {
        const c = clockState({ dueAt: NOW + 30 * DAY_MS, startedAt: NOW - 3 * HOUR_MS, doneAt: NOW - HOUR_MS, now: NOW });
        expect(c.completedInDays).toBe(1);
    });

    it('done LATE keeps how late it was in overdueValue, in the window\'s unit', () => {
        const s = '2026-07-01T10:00:00Z';
        const c = clockState({ dueAt: '2026-07-31T10:00:00Z', startedAt: s, doneAt: '2026-08-03T12:00:00Z', now: NOW });
        expect(c.state).toBe('done');
        expect(c.completedInDays).toBe(34);
        expect(c.overdueValue).toBe(4);
    });

    it('done without a known start: state done, no day count to show', () => {
        const c = clockState({ dueAt: NOW, doneAt: NOW - DAY_MS, now: NOW });
        expect(c.state).toBe('done');
        expect(c.completedInDays).toBeNull();
        expect(c.value).toBeNull();
    });

    it('no due date → none, nothing to draw', () => {
        const c = clockState({ startedAt: NOW - DAY_MS, now: NOW });
        expect(c.state).toBe('none');
        expect(c.remainingMs).toBeNull();
        expect(c.value).toBeNull();
        expect(c.pct).toBe(0);
        expect(clockState({}).state).toBe('none');
        expect(clockState().state).toBe('none');
    });

    it('a due date with no start (a training due date) counts in days with an empty bar', () => {
        const c = clockState({ dueAt: NOW + 3 * DAY_MS, now: NOW, urgentBelowMs: 14 * DAY_MS });
        expect(c.unit).toBe('days');
        expect(c.value).toBe(3);
        expect(c.state).toBe('urgent');
        expect(c.pct).toBe(0);
    });

    it('an explicit unit overrides the window rule', () => {
        const c = clockState({ dueAt: NOW + 2 * DAY_MS, startedAt: NOW - DAY_MS, now: NOW, unit: 'days' });
        expect(c.unit).toBe('days');
        expect(c.value).toBe(2);
    });

    it('accepts Date objects, epoch numbers and ISO strings alike; garbage is null', () => {
        expect(toMs(new Date(NOW))).toBe(NOW);
        expect(toMs(NOW)).toBe(NOW);
        expect(toMs(new Date(NOW).toISOString())).toBe(NOW);
        expect(toMs('not a date')).toBeNull();
        expect(toMs(null)).toBeNull();
        expect(toMs(undefined)).toBeNull();
        expect(toMs('')).toBeNull();
        expect(clockState({ dueAt: 'not a date', now: NOW }).state).toBe('none');
    });

    it('the bar never leaves 0..1 even when now runs ahead of the window or behind its start', () => {
        const early = clockState({ dueAt: NOW + 20 * DAY_MS, startedAt: NOW + DAY_MS, now: NOW });
        expect(early.pct).toBe(0);
        const inverted = clockState({ dueAt: NOW + DAY_MS, startedAt: NOW + 5 * DAY_MS, now: NOW });
        expect(inverted.pct).toBe(0);
        expect(inverted.unit).toBe('days');
    });
});

describe('server helpers', () => {
    it('normalisePct clamps and accepts a 0..100 producer', () => {
        expect(normalisePct(0.43)).toBeCloseTo(0.43);
        expect(normalisePct(43)).toBeCloseTo(0.43);
        expect(normalisePct(1)).toBe(1);
        expect(normalisePct(-2)).toBe(0);
        expect(normalisePct(null)).toBeNull();
        expect(normalisePct('x')).toBeNull();
    });

    it('isClockState trusts only the five states', () => {
        for (const s of CLOCK_STATES) expect(isClockState(s)).toBe(true);
        expect(isClockState('late')).toBe(false);
        expect(isClockState(undefined)).toBe(false);
    });
});
