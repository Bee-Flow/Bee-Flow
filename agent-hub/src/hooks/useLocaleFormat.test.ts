import { describe, expect, it } from 'vitest';
import { intlLocale, localeFormat } from './useLocaleFormat';

describe('localeFormat', () => {
    it('writes English the British way and Dutch the Dutch way', () => {
        expect(intlLocale('en')).toBe('en-GB');
        expect(intlLocale(undefined)).toBe('en-GB');
        expect(intlLocale('nl')).toBe('nl');
        const day = new Date(2026, 10, 8);
        expect(localeFormat('en').day(day)).toBe('8 Nov 2026');
        expect(localeFormat('en').dayRange(day, new Date(2026, 10, 15))).toBe('8 Nov 2026 – 15 Nov 2026');
        expect(localeFormat('nl').number(10000)).toBe('10.000');
        expect(localeFormat('en').number(10000)).toBe('10,000');
    });

    it('says how long ago within a day, then the day', () => {
        const now = new Date(2026, 10, 15, 12, 0).getTime();
        const f = localeFormat('en');
        expect(f.relative(now - 5 * 60_000, now)).toMatch(/5 min/);
        expect(f.relative(now - 3 * 3_600_000, now)).toMatch(/3 hr/);
        expect(f.relative(new Date(2026, 10, 8, 9, 0), now)).toBe('8 Nov');
        expect(f.relative(null, now)).toBe('');
        expect(f.day('not a date')).toBe('');
    });
});
