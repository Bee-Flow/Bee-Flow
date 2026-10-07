import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatDay, formatDayTime, formatStamp, useDateFormat } from './formatDates';

/**
 * The one date style of the Compliance Center. Every fixture is built from
 * LOCAL date parts, so the test reads the same in every time zone.
 */
const NOW = new Date(2026, 9, 6, 9, 15).getTime(); // 6 Oct 2026
const EVENING = new Date(2026, 7, 19, 20, 38, 5); // 19 Aug 2026 20:38:05
const LAST_YEAR = new Date(2025, 2, 3, 7, 4, 9); // 3 Mar 2025 07:04:09

describe('formatDay', () => {
    it('day and short month, no year in the current year (en and nl)', () => {
        expect(formatDay(EVENING, 'en', NOW)).toBe('19 Aug');
        expect(formatDay(EVENING, 'nl', NOW)).toBe('19 aug');
        expect(formatDay(EVENING.toISOString(), 'en', NOW)).toBe('19 Aug');
        expect(formatDay(EVENING.getTime(), 'en', NOW)).toBe('19 Aug');
    });

    it('the year is added when it is not the current one', () => {
        expect(formatDay(LAST_YEAR, 'en', NOW)).toBe('3 Mar 2025');
        expect(formatDay(LAST_YEAR, 'nl', NOW)).toBe('3 mrt 2025');
        expect(formatDay('2027-01-12', 'en', NOW)).toBe('12 Jan 2027');
    });

    it('a bare YYYY-MM-DD is that local day, never the day before', () => {
        expect(formatDay('2026-12-02', 'en', NOW)).toBe('2 Dec');
        expect(formatDay('2026-12-02', 'nl', NOW)).toBe('2 dec');
    });

    it('English months are three letters (ICU en-GB says "Sept")', () => {
        expect(formatDay(new Date(2026, 8, 14), 'en', NOW)).toBe('14 Sep');
    });

    it('anything that is not a date gives an empty string', () => {
        expect(formatDay(null, 'en', NOW)).toBe('');
        expect(formatDay(undefined, 'en', NOW)).toBe('');
        expect(formatDay('', 'en', NOW)).toBe('');
        expect(formatDay('soon', 'en', NOW)).toBe('');
    });
});

describe('formatDayTime and formatStamp', () => {
    it('24-hour time after the day, in both languages', () => {
        expect(formatDayTime(EVENING, 'en', NOW)).toBe('19 Aug 20:38');
        expect(formatDayTime(EVENING, 'nl', NOW)).toBe('19 aug 20:38');
        expect(formatDayTime(LAST_YEAR, 'en', NOW)).toBe('3 Mar 2025 07:04');
    });

    it('the stamp carries the seconds (the Access log)', () => {
        expect(formatStamp(EVENING, 'en', NOW)).toBe('19 Aug 20:38:05');
        expect(formatStamp(LAST_YEAR, 'nl', NOW)).toBe('3 mrt 2025 07:04:09');
    });

    it('a bare day prints only the day; garbage stays empty', () => {
        expect(formatDayTime('2026-08-19', 'en', NOW)).toBe('19 Aug');
        expect(formatStamp('2026-08-19', 'en', NOW)).toBe('19 Aug');
        expect(formatDayTime('nope', 'en', NOW)).toBe('');
        expect(formatStamp(null, 'en', NOW)).toBe('');
    });
});

describe('useDateFormat', () => {
    it('binds the formatters to the language on screen (English without a catalogue)', () => {
        const { result } = renderHook(() => useDateFormat());
        expect(result.current.locale).toBe('en');
        expect(result.current.formatDay('2026-12-02')).toMatch(/^2 Dec( 2026)?$/);
        expect(result.current.formatDayTime(new Date(2026, 11, 2, 18, 5))).toMatch(/^2 Dec( 2026)? 18:05$/);
        expect(result.current.formatStamp(new Date(2026, 11, 2, 18, 5, 7))).toMatch(/^2 Dec( 2026)? 18:05:07$/);
    });

    it('returns the same functions between renders', () => {
        const { result, rerender } = renderHook(() => useDateFormat());
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});
