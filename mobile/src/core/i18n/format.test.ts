/**
 * Numbers, dates and relative times in the app's language.
 *
 * The bugs these pin: a chart axis that said "2,500" and "Mar" inside a Dutch
 * app, token counts formatted as 'en-US' whatever the language, "Bijgewerkt
 * 5m ago", and — the one that misled people — a deadline a week away that
 * read "now".
 */

import { FUTURE_SLACK } from '@/shared/lib/time';

import { FUTURE_SLACK_SECONDS, formatDate, formatDay, formatMoment, formatNumber, formatWhen, timeAgo } from './format';
import { _reset, setCatalogue } from './store';

const NOW = Date.parse('2026-03-12T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const DUTCH = {
    'time.just_now': 'zojuist',
    'time.minutes_ago': '{count} min geleden',
    'time.hours_ago': '{count} uur geleden',
    'time.days_ago': '{count} d geleden',
};

beforeEach(() => _reset());

describe('formatNumber / formatDate follow the app, not the phone', () => {
    it('groups and separates as the app language does', () => {
        expect(formatNumber(2500)).toBe('2,500');
        expect(formatNumber(2.5)).toBe('2.5');
        setCatalogue('nl', {});
        expect(formatNumber(2500)).toBe('2.500');
        expect(formatNumber(2.5)).toBe('2,5');
        expect(formatNumber(12.5, { style: 'currency', currency: 'EUR' })).toMatch(/12,50/);
    });

    it('names the month in the app language', () => {
        const march = Date.UTC(2026, 2, 5, 12);
        expect(formatDate(march, { month: 'long', timeZone: 'UTC' })).toBe('March');
        setCatalogue('nl', {});
        expect(formatDate(march, { month: 'long', timeZone: 'UTC' })).toBe('maart');
    });

    it('falls back to English for a language Intl has no data for, and still throws on a bad option', () => {
        setCatalogue('xx-not-a-locale-tag-at-all-!!', {});
        expect(formatNumber(2500)).toBe('2,500');
        expect(() => formatNumber(1, { style: 'currency', currency: 'NOT-A-CURRENCY' })).toThrow(RangeError);
    });

    it('says nothing for a missing or broken date', () => {
        expect(formatDate(null)).toBe('');
        expect(formatDate('not a date')).toBe('');
        expect(formatWhen(undefined)).toBe('—');
    });
});

describe('formatWhen — a deadline or a moment, as the web writes it', () => {
    it('reads as a date and a time, with the year only when it is not this one', () => {
        const thisYear = formatWhen('2026-08-12T14:03:00', NOW);
        expect(thisYear).toMatch(/12/);
        expect(thisYear).toMatch(/Aug/);
        expect(thisYear).not.toMatch(/2026/);
        expect(formatWhen('2024-08-12T14:03:00', NOW)).toMatch(/2024/);
        setCatalogue('nl', {});
        expect(formatWhen('2026-08-12T14:03:00', NOW)).toMatch(/aug/);
    });
});

describe('formatMoment — "Today at 09:00", one sentence per phrase', () => {
    // Local wall-clock dates: "today" is the device's calendar day.
    const now = new Date(2026, 2, 12, 12, 0).getTime();
    const at = (day: number, hour = 9, year = 2026) => new Date(year, 2, day, hour, 0);

    it('names today, tomorrow and yesterday, and dates the rest', () => {
        expect(formatMoment(at(12), now)).toMatch(/^Today at 09:00/);
        expect(formatMoment(at(13, 23), now)).toMatch(/^Tomorrow at 11:00/);
        expect(formatMoment(at(11, 0), now)).toMatch(/^Yesterday at 12:00/);
        expect(formatMoment(at(20), now)).toMatch(/^Mar 20 at 09:00/);
        expect(formatMoment(at(20, 9, 2027), now)).toMatch(/^Mar 20, 2027 at 09:00/);
    });

    it('lets a translation put the time where its grammar wants it, in its own clock', () => {
        setCatalogue('nl', {
            'mobile.time.today_at': 'Vandaag om {time}',
            'mobile.time.tomorrow_at': 'Morgen om {time}',
            'mobile.time.date_at': '{date} om {time}',
        });
        expect(formatMoment(at(12, 14), now)).toBe('Vandaag om 14:00');
        expect(formatMoment(at(13, 9), now)).toBe('Morgen om 09:00');
        expect(formatMoment(at(20, 9), now)).toBe('20 mrt om 09:00');
    });

    it('says nothing useful about nothing: an em dash', () => {
        expect(formatMoment(null, now)).toBe('—');
        expect(formatMoment('not a date', now)).toBe('—');
    });
});

describe('formatDay', () => {
    it('is a day with no clock, with the year once it is not this one', () => {
        const now = new Date(2026, 2, 12, 12, 0).getTime();
        expect(formatDay(new Date(2026, 2, 1, 8), now)).toBe('Mar 1');
        expect(formatDay(new Date(2025, 2, 1, 8), now)).toBe('Mar 1, 2025');
        setCatalogue('nl', {});
        expect(formatDay(new Date(2026, 2, 1, 8), now)).toBe('1 mrt');
        expect(formatDay(null, now)).toBe('');
    });
});

describe('timeAgo', () => {
    it('is relativeTime with the same thresholds, as a bare token', () => {
        expect(timeAgo(ago(5), {}, NOW)).toBe('now');
        expect(timeAgo(ago(90), {}, NOW)).toBe('1m');
        expect(timeAgo(ago(119 * 60), {}, NOW)).toBe('1h');
        expect(timeAgo(ago(47 * 3600), {}, NOW)).toBe('1d');
    });

    it('borrows the web’s time.* words for a phrase, so a Dutch sentence stays Dutch', () => {
        expect(timeAgo(ago(5), { suffix: true }, NOW)).toBe('just now');
        expect(timeAgo(ago(120), { suffix: true }, NOW)).toBe('2m ago');
        setCatalogue('nl', DUTCH);
        expect(timeAgo(ago(5), { suffix: true }, NOW)).toBe('zojuist');
        expect(timeAgo(ago(120), { suffix: true }, NOW)).toBe('2 min geleden');
        expect(timeAgo(ago(7200), { suffix: true }, NOW)).toBe('2 uur geleden');
        expect(timeAgo(ago(3 * 86_400), { suffix: true }, NOW)).toBe('3 d geleden');
    });

    it('becomes a date in the app language after a week', () => {
        setCatalogue('nl', DUTCH);
        expect(timeAgo('2026-03-01T12:00:00.000Z', {}, NOW)).toMatch(/mrt/);
        expect(timeAgo('2025-03-01T12:00:00.000Z', {}, NOW)).toMatch(/2025/);
    });

    it('never calls a date clearly in the future "now"', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(timeAgo(new Date(NOW + 30_000), {}, NOW)).toBe('now');
            expect(timeAgo(new Date(NOW + 7 * 86_400_000), {}, NOW)).toBe('');
            expect(timeAgo(new Date(NOW + 7 * 86_400_000), { suffix: true }, NOW)).toBe('');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('future time'));
        } finally {
            warn.mockRestore();
        }
    });

    it('allows the same clock skew as relativeTime', () => {
        expect(FUTURE_SLACK_SECONDS).toBe(FUTURE_SLACK);
    });

    it('says nothing for a missing or broken timestamp', () => {
        expect(timeAgo(null)).toBe('');
        expect(timeAgo('')).toBe('');
        expect(timeAgo('not a date')).toBe('');
    });
});
