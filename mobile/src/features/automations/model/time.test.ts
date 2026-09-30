/**
 * A schedule's moment, in the app's language.
 *
 * absoluteTime used to glue English ("Today at", "Tomorrow at") to the phone's
 * clock, so a Dutch run screen read "Today at 09:00". It is core/i18n's
 * formatMoment now; this pins that the run screens get it.
 */

import { _reset, setCatalogue } from '@/core/i18n';

import { absoluteTime } from './time';

const NOW = new Date(2026, 2, 12, 12, 0);

beforeEach(() => {
    _reset();
    jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('absoluteTime', () => {
    it('says today, tomorrow and yesterday as the web does, and dates the rest', () => {
        expect(absoluteTime(new Date(2026, 2, 12, 9, 0).toISOString())).toMatch(/^Today at 09:00/);
        expect(absoluteTime(new Date(2026, 2, 13, 9, 0).toISOString())).toMatch(/^Tomorrow at 09:00/);
        expect(absoluteTime(new Date(2026, 2, 11, 9, 0).toISOString())).toMatch(/^Yesterday at 09:00/);
        expect(absoluteTime(new Date(2026, 2, 20, 9, 0).toISOString())).toMatch(/^Mar 20 at 09:00/);
    });

    it('is one sentence in the app language, not English around a clock', () => {
        setCatalogue('nl', { 'mobile.time.tomorrow_at': 'Morgen om {time}' });
        expect(absoluteTime(new Date(2026, 2, 13, 14, 30).toISOString())).toBe('Morgen om 14:30');
    });

    it('reads a missing or broken time as an em dash', () => {
        expect(absoluteTime(null)).toBe('—');
        expect(absoluteTime('not a date')).toBe('—');
    });
});
