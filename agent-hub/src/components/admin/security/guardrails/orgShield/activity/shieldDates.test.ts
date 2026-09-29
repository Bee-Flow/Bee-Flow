// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { clockTime, dayKey, daySpan, formatDay, formatPeriod, intlLocale } from './shieldDates';

const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe('dayKey / clockTime', () => {
    it('reads the LOCAL day and clock', () => {
        expect(dayKey(local(2026, 9, 28, 23, 59))).toBe('2026-09-28');
        expect(dayKey(local(2026, 9, 29, 0, 1).toISOString())).toBe('2026-09-29');
        expect(clockTime(local(2026, 9, 28, 7, 5))).toBe('07:05');
    });

    it('returns nothing for a broken timestamp', () => {
        expect(dayKey('not a date')).toBeNull();
        expect(dayKey(null)).toBeNull();
        expect(clockTime(undefined)).toBe('');
    });
});

describe('daySpan', () => {
    it('lists every day from start to end, both included', () => {
        expect(daySpan(local(2026, 9, 26, 17), local(2026, 9, 28, 9))).toEqual(['2026-09-26', '2026-09-27', '2026-09-28']);
    });

    it('crosses a month end', () => {
        expect(daySpan(local(2026, 8, 31), local(2026, 9, 1))).toEqual(['2026-08-31', '2026-09-01']);
    });

    it('is empty for a window that ends before it starts', () => {
        expect(daySpan(local(2026, 9, 28), local(2026, 9, 1))).toEqual([]);
    });
});

describe('formatting', () => {
    it('reads the plain English locale the European way', () => {
        expect(intlLocale('en')).toBe('en-GB');
        expect(intlLocale('nl')).toBe('nl');
    });

    it('a day with its weekday, without a comma', () => {
        expect(formatDay('2026-09-28', 'en', { weekday: true })).toMatch(/^Mon 28 Sept?$/);
        expect(formatDay('2026-09-28', 'en')).toMatch(/^28 Sept?$/);
    });

    it('a period with the year once', () => {
        expect(formatPeriod(local(2026, 8, 30).toISOString(), local(2026, 9, 28).toISOString(), 'en')).toMatch(/^30 Aug\s?–\s?28 Sept? 2026$/);
        expect(formatPeriod(null, null, 'en')).toBe('');
    });
});
