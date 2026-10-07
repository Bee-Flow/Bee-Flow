/**
 * Differential: the port against the web's shared/calendarMath.js, run on
 * the same fixtures with a fixed now.
 */

import { loadWebModule } from '@/shared/testing/webModule';

import * as port from './calendarMath';

const web = loadWebModule<typeof port>('components/admin/compliance/shared/calendarMath.js');

const NOW = new Date(2026, 8, 14, 15, 30).getTime(); // 14 Sep 2026, afternoon, local
const DAYS = ['2026-09-14', '2026-09-13', '2026-12-02', '2027-01-20', '2026-12-12', '2026-13-45', 'nope', '', null, undefined, '2026-09-14T23:59:00Z', 1_790_000_000_000];
const MILESTONES = [
    { id: 'a', date: '2026-12-02', kind: 'phase' },
    { id: 'b', date: '2025-02-02', kind: 'in_force' },
    { id: 'c', date: null, kind: 'uncertain' },
    { id: 'd', date: '2026-09-14', kind: 'phase' },
    { id: 'e', date: '2026-08-02', kind: 'phase' },
    { id: 'f', date: '2027-08-02', kind: 'uncertain' },
    { id: 'g', date: 'garbage', kind: 'phase' },
];

describe('calendarMath (differential)', () => {
    it('agrees on parseDay and daysUntil', () => {
        for (const d of DAYS) {
            expect(port.parseDay(d as never)).toBe(web.parseDay(d as never));
            expect(port.daysUntil(d as never, NOW)).toBe(web.daysUntil(d as never, NOW));
        }
    });

    it('parses a day string as local midnight', () => {
        expect(port.parseDay('2026-12-02')).toBe(new Date(2026, 11, 2).getTime());
        expect(port.daysUntil('2026-09-14', NOW)).toBe(0);
        expect(port.daysUntil('2026-09-13', NOW)).toBe(-1);
    });

    it('agrees on splitByToday', () => {
        type Split = { past: { id?: string }[]; upcoming: { id?: string }[]; uncertain: { id?: string }[] };
        const ids = (s: Split) => ({ past: s.past.map((m) => m.id), upcoming: s.upcoming.map((m) => m.id), uncertain: s.uncertain.map((m) => m.id) });
        expect(ids(port.splitByToday(MILESTONES, NOW))).toEqual(ids(web.splitByToday(MILESTONES, NOW)));
        expect(ids(port.splitByToday(MILESTONES, NOW))).toEqual({ past: ['b', 'e'], upcoming: ['d', 'a'], uncertain: ['c', 'f', 'g'] });
    });

    it('agrees on countdown, startOfDay and SOON_DAYS', () => {
        for (const n of [null, undefined, -1, 0, 1, 79, 90, 91, 120, 400, Number.NaN]) expect(port.countdown(n as never)).toEqual(web.countdown(n as never));
        expect(port.startOfDay(NOW)).toBe(web.startOfDay(NOW));
        expect(port.SOON_DAYS).toBe(web.SOON_DAYS);
        expect(port.countdown(79)).toEqual({ unit: 'days', n: 79, soon: true });
        expect(port.countdown(120)).toEqual({ unit: 'months', n: 4, soon: false });
    });

    it('agrees on formatCalDate', () => {
        for (const year of ['always', 'auto', 'never'] as const) {
            for (const locale of ['en', 'nl', 'de']) {
                for (const d of ['2026-12-02', '2027-01-20', '2026-09-14', 'x']) {
                    expect(port.formatCalDate(d, { locale, now: NOW, year })).toBe(web.formatCalDate(d, { locale, now: NOW, year }));
                }
            }
        }
        expect(port.formatCalDate('2026-09-14', { now: NOW })).toBe('14 Sep 2026');
        expect(port.formatCalDate('2027-01-20', { now: NOW, year: 'auto' })).toBe("20 Jan '27");
    });
});
