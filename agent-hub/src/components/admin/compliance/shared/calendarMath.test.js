// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    countdown, daysUntil, formatCalDate, intlLocale, parseDay, resolveNow, splitByToday, startOfDay, DAY_MS, SOON_DAYS,
} from './calendarMath';

// The artboard's day: 14 Sep 2026, mid-afternoon local.
const NOW = new Date(2026, 8, 14, 15, 30).getTime();
const ms = (id, date, extra = {}) => ({ id, date, framework_id: 'x', kind: 'in_force', label_key: `compliance.cal_ms_${id}_label`, ...extra });

describe('calendarMath.parseDay / daysUntil — local midnights, never UTC', () => {
    it("parses 'YYYY-MM-DD' as LOCAL midnight (a UTC parse would be the day before in Amsterdam)", () => {
        const d = new Date(parseDay('2026-12-02'));
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 11, 2, 0]);
        expect(parseDay(' 2027-01-12 ')).toBe(new Date(2027, 0, 12).getTime());
    });

    it('accepts a Date, an ISO datetime and an epoch, snapping each to its local midnight', () => {
        const noon = new Date(2026, 8, 14, 12);
        expect(parseDay(noon)).toBe(startOfDay(noon.getTime()));
        expect(parseDay(noon.toISOString())).toBe(startOfDay(noon.getTime()));
        expect(parseDay(noon.getTime())).toBe(startOfDay(noon.getTime()));
    });

    it('returns null for anything unparseable instead of throwing', () => {
        for (const v of [null, undefined, '', 'soon', '2026-13-45x', '2026-13-45', '2026-02-30', {}, NaN]) expect(parseDay(v)).toBeNull();
        expect(daysUntil('later', NOW)).toBeNull();
    });

    it('counts whole days between midnights regardless of the hour of `now`', () => {
        expect(daysUntil('2026-12-02', NOW)).toBe(79);   // the artboard's "over 79 dagen"
        expect(daysUntil('2026-12-09', NOW)).toBe(86);
        expect(daysUntil('2027-01-12', NOW)).toBe(120);
        expect(daysUntil('2026-09-14', NOW)).toBe(0);    // today, late afternoon
        expect(daysUntil('2026-09-14', new Date(2026, 8, 14, 0, 5))).toBe(0);
        expect(daysUntil('2026-08-15', NOW)).toBe(-30);  // NIS2 "30 dagen geleden"
        expect(daysUntil('2026-09-11', NOW)).toBe(-3);
        expect(daysUntil('2026-09-13', new Date(2026, 8, 14, 0, 1))).toBe(-1); // just past midnight: still one full day
    });

    it('resolveNow: a Date, a number, or the real clock', () => {
        expect(resolveNow(new Date(NOW))).toBe(NOW);
        expect(resolveNow(NOW)).toBe(NOW);
        const before = Date.now();
        for (const v of [undefined, null, 'x', NaN]) expect(resolveNow(v)).toBeGreaterThanOrEqual(before);
        expect(DAY_MS).toBe(86_400_000);
    });
});

describe('calendarMath.splitByToday', () => {
    const list = [
        ms('nis2', '2026-08-15'),
        ms('aia_art50', '2026-12-02', { kind: 'transition_end' }),
        ms('dora', '2025-01-17', { relevant: false }),
        ms('omnibus', null, { kind: 'uncertain', expected: '2026-Q4' }),
        ms('pld', '2026-12-09'),
        ms('cra_art14', '2026-09-11'),
        ms('broken', 'someday'),
        ms('today', '2026-09-14'),
    ];

    it('splits on today: past oldest-first, upcoming nearest-first, undated or uncertain to the footer', () => {
        const { past, upcoming, uncertain } = splitByToday(list, NOW);
        expect(past.map(m => m.id)).toEqual(['dora', 'nis2', 'cra_art14']);
        expect(upcoming.map(m => m.id)).toEqual(['today', 'aia_art50', 'pld']);
        expect(uncertain.map(m => m.id)).toEqual(['omnibus', 'broken']);
    });

    it('a same-day milestone is UPCOMING — a date that falls today is not yet history', () => {
        const { past, upcoming } = splitByToday([ms('t', '2026-09-14')], new Date(2026, 8, 14, 23, 59));
        expect(past).toEqual([]);
        expect(upcoming.map(m => m.id)).toEqual(['t']);
    });

    it('all past / all future / empty / garbage input', () => {
        const allPast = splitByToday([ms('a', '2020-01-01'), ms('b', '2019-06-30')], NOW);
        expect(allPast.past.map(m => m.id)).toEqual(['b', 'a']);
        expect(allPast.upcoming).toEqual([]);
        const allFuture = splitByToday([ms('a', '2028-08-02'), ms('b', '2027-12-02')], NOW);
        expect(allFuture.upcoming.map(m => m.id)).toEqual(['b', 'a']);
        expect(allFuture.past).toEqual([]);
        for (const bad of [undefined, null, [], 'x', [null, 5, 'y']]) {
            expect(splitByToday(bad, NOW)).toEqual({ past: [], upcoming: [], uncertain: [] });
        }
    });

    it('keeps the caller’s objects (no copies), so identity-based selection still works', () => {
        const item = ms('a', '2027-01-12');
        expect(splitByToday([item], NOW).upcoming[0]).toBe(item);
    });
});

describe('calendarMath.countdown — days up to 90, months beyond', () => {
    it('words the distance and flags "soon" at or under 90 days', () => {
        expect(SOON_DAYS).toBe(90);
        expect(countdown(0)).toEqual({ unit: 'today', n: 0, soon: true });
        expect(countdown(1)).toEqual({ unit: 'days', n: 1, soon: true });
        expect(countdown(79)).toEqual({ unit: 'days', n: 79, soon: true });
        expect(countdown(90)).toEqual({ unit: 'days', n: 90, soon: true });
        expect(countdown(91)).toEqual({ unit: 'months', n: 3, soon: false });
        expect(countdown(120)).toEqual({ unit: 'months', n: 4, soon: false }); // "over 4 maanden"
        expect(countdown(444)).toEqual({ unit: 'months', n: 15, soon: false });
    });

    it('has nothing to say about the past or the unknown', () => {
        expect(countdown(-3)).toBeNull();
        expect(countdown(null)).toBeNull();
        expect(countdown(undefined)).toBeNull();
        expect(countdown(NaN)).toBeNull();
    });
});

describe('calendarMath.formatCalDate — the artboard’s date column', () => {
    it("full column: always the year, no ICU period after the month ('2 dec 2026')", () => {
        expect(formatCalDate('2026-12-02', { locale: 'nl', now: NOW })).toBe('2 dec 2026');
        expect(formatCalDate('2027-01-12', { locale: 'nl', now: NOW })).toBe('12 jan 2027');
        expect(formatCalDate('2026-12-02', { locale: 'en', now: NOW })).toBe('2 Dec 2026');
    });

    it("compact column: the year only when it is not the current one ('2 dec' / \"12 jan '27\")", () => {
        expect(formatCalDate('2026-12-02', { locale: 'nl', now: NOW, year: 'auto' })).toBe('2 dec');
        expect(formatCalDate('2027-01-12', { locale: 'nl', now: NOW, year: 'auto' })).toBe("12 jan '27");
        expect(formatCalDate('2026-12-09', { locale: 'en', now: NOW, year: 'never' })).toBe('9 Dec');
        expect(formatCalDate('2027-12-02', { locale: 'en', now: NOW, year: 'never' })).toBe('2 Dec');
    });

    it("plain 'en' formats day-first (en-GB), other tags pass through, garbage falls back", () => {
        expect(intlLocale('en')).toBe('en-GB');
        expect(intlLocale('nl')).toBe('nl');
        expect(intlLocale('de-AT')).toBe('de-AT');
        expect(intlLocale(undefined)).toBe('en-GB');
        expect(formatCalDate('2026-12-02', { locale: 'not-a-real-tag-!!', now: NOW })).toMatch(/2 Dec 2026/);
        expect(formatCalDate('nonsense', { locale: 'nl' })).toBe('');
        expect(formatCalDate(NOW, { locale: 'nl', now: NOW })).toBe('14 sep 2026'); // an epoch works too (the today divider)
    });

    it('English months are always three letters — ICU en-GB says "Sept", the column says "Sep"', () => {
        expect(formatCalDate('2026-09-14', { locale: 'en', now: NOW })).toBe('14 Sep 2026');
        expect(formatCalDate('2026-09-14', { locale: 'en-GB', now: NOW, year: 'never' })).toBe('14 Sep');
        expect(formatCalDate('2026-09-14', { locale: 'en-US', now: NOW, year: 'never' })).toMatch(/^Sep 14$/);
        // Not an English rule: Dutch keeps its own abbreviation, German its ordinal day.
        expect(formatCalDate('2026-09-14', { locale: 'nl', now: NOW })).toBe('14 sep 2026');
        expect(formatCalDate('2026-09-14', { locale: 'de', now: NOW })).toBe('14. Sept 2026');
    });
});
