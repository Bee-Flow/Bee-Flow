/**
 * The deadline maths against the web's own module (differential: the web
 * file is pure), the resolveClock merge, and the clock words pinned to the
 * web's keys in shared/DeadlineClock.jsx.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { clockLabel, clockRowLabel } from './clockLabels';
import * as port from './deadlineMath';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../../agent-hub/src/components/shared/deadlineMath.js');

const H = port.HOUR_MS;
const D = port.DAY_MS;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const CASES: port.ClockInput[] = [
    {},
    { dueAt: NOW + 3 * D, startedAt: NOW - 27 * D, now: NOW, urgentBelowMs: 5 * D },
    { dueAt: NOW + 10 * D, startedAt: NOW - 20 * D, now: NOW, urgentBelowMs: 5 * D },
    { dueAt: NOW - 31 * D, startedAt: NOW - 61 * D, now: NOW },
    { dueAt: NOW + 5 * H, startedAt: NOW - 67 * H, now: NOW, urgentBelowMs: 24 * H },
    { dueAt: NOW - 3 * H, startedAt: NOW - 75 * H, now: NOW },
    { dueAt: NOW - 50 * H, startedAt: NOW - 122 * H, now: NOW },
    { dueAt: NOW - 50 * H, startedAt: NOW - 122 * H, now: NOW, unit: 'hours' },
    { dueAt: NOW + 2 * D, now: NOW },
    { dueAt: NOW + 2 * D, startedAt: NOW - 2 * D, doneAt: NOW - D, now: NOW },
    { dueAt: NOW - 2 * D, startedAt: NOW - 9 * D, doneAt: NOW, now: NOW },
    { dueAt: new Date(NOW + H).toISOString(), startedAt: new Date(NOW - H).toISOString(), now: NOW },
    { dueAt: 'not a date', now: NOW },
];

describe('deadlineMath matches the web', () => {
    it.each(CASES.map((c, i) => [i, c]))('clockState case %i', (_i, input) => {
        expect(port.clockState(input as port.ClockInput)).toEqual(web.clockState(input));
    });

    it('keeps the constants', () => {
        expect([port.HOUR_MS, port.DAY_MS, port.DAYS_WINDOW_MS, port.OVERDUE_IN_DAYS_AFTER_MS]).toEqual([web.HOUR_MS, web.DAY_MS, web.DAYS_WINDOW_MS, web.OVERDUE_IN_DAYS_AFTER_MS]);
        expect([...port.CLOCK_STATES]).toEqual([...web.CLOCK_STATES]);
    });

    it.each([
        ['2026-01-31T10:00:00Z', 1],
        ['2024-01-31T00:00:00Z', 1],
        ['2026-03-31T23:30:00Z', -1],
        ['2026-08-15T00:00:00Z', 2],
        [null, 1],
        ['2026-01-01', 1.5],
    ])('addCalendarMonths(%s, %s)', (value, months) => {
        expect(port.addCalendarMonths(value, months)).toEqual(web.addCalendarMonths(value, months));
    });

    it.each([0.4, 40, 150, -1, 'x', null, undefined, '0.5'])('normalisePct(%s)', (pct) => {
        expect(port.normalisePct(pct)).toEqual(web.normalisePct(pct));
    });

    it.each(['ok', 'urgent', 'overdue', 'done', 'none', 'late', null])('isClockState(%s)', (s) => {
        expect(port.isClockState(s)).toBe(web.isClockState(s));
    });
});

describe('resolveClock', () => {
    it('lets the server state and pct win', () => {
        const c = port.resolveClock({ dueAt: NOW + 10 * D, startedAt: NOW - 20 * D, now: NOW, state: 'urgent', pct: 80 });
        expect(c.state).toBe('urgent');
        expect(c.pct).toBe(0.8);
        expect(c.value).toBe(10);
    });

    it('draws a closed clock without numbers from local maths', () => {
        expect(port.resolveClock({ dueAt: NOW + D, now: NOW, state: 'done', pct: 0.3 }).pct).toBe(1);
        expect(port.resolveClock({ dueAt: NOW + D, now: NOW, state: 'none' }).pct).toBe(0);
    });

    it('ignores a state that is not ours', () => {
        expect(port.resolveClock({ dueAt: NOW - D, now: NOW, state: 'late' }).state).toBe('overdue');
    });
});

describe('clock words', () => {
    const t = (_k: string, en: string, p?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, k: string) => String(p?.[k]));

    it('says the full sentence with _one plurals', () => {
        expect(clockLabel(t, port.clockState({ dueAt: NOW + 3 * D, startedAt: NOW - 27 * D, now: NOW }))).toBe('3 days left');
        expect(clockLabel(t, port.clockState({ dueAt: NOW + H, startedAt: NOW - 71 * H, now: NOW }))).toBe('1 hour left');
        expect(clockLabel(t, port.clockState({ dueAt: NOW - D, now: NOW }))).toBe('overdue by 1 day');
        expect(clockLabel(t, port.clockState({ dueAt: NOW - 5 * H, startedAt: NOW - 77 * H, now: NOW }))).toBe('overdue by 5 hours');
        expect(clockLabel(t, port.clockState({ startedAt: NOW - 2 * D, doneAt: NOW, now: NOW }))).toBe('completed in 2 days');
        expect(clockLabel(t, port.clockState({ doneAt: NOW, now: NOW }))).toBe('completed');
        expect(clockLabel(t, port.clockState({}))).toBe('no open deadline');
    });

    it('says the compact row form', () => {
        expect(clockRowLabel(t, port.clockState({ dueAt: NOW + 5 * H, startedAt: NOW - 67 * H, now: NOW }))).toBe('5 h left');
        expect(clockRowLabel(t, port.clockState({ dueAt: NOW - 31 * D, now: NOW }))).toBe('31 d overdue');
    });

    it('borrows every key and English fallback the web uses', () => {
        const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/shared/DeadlineClock.jsx`, 'utf8');
        const mine = fs.readFileSync(`${__dirname}/clockLabels.ts`, 'utf8');
        const pairs = (text: string) => new Set([...text.matchAll(/t\('(compliance\.clock_(?!short)[a-z_]+)', '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`));
        expect(pairs(mine)).toEqual(pairs(src));
    });
});
