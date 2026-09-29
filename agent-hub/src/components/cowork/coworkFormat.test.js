// @vitest-environment node
/**
 * coworkFormat — the three strings the whole Cowork surface is dated by.
 *
 * `relativeTime` is still pinned as characterisation, warts and all: the list
 * column is its only reader and CW-16 deliberately left it alone. The other
 * two describes are no longer characterisation — they state what CW-16 asked
 * for (relative day names, one duration shape) as properties, so the wording
 * can be re-tuned without rewriting the suite but the SHAPE cannot slip back.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/cowork/coworkFormat.test.js
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { relativeTime, formatDuration, fullTimestamp } from './coworkFormat';

const NOW = new Date(2026, 8, 6, 12, 0, 0);          // 6 Sep 2026, 12:00 local
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO string `ms` milliseconds before the frozen NOW. */
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

// The host locale these expectations were recorded against. Node/CI runs
// en-US, which is also what makes the 12-hour clock below visible; the
// exact-string pins are skipped elsewhere rather than failing on a Dutch box.
const HOST_LOCALE = new Intl.DateTimeFormat().resolvedOptions().locale;
const IS_EN_US = HOST_LOCALE === 'en-US';

describe('relativeTime — "how long ago"', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it('gives an empty string for nothing at all', () => {
        expect(relativeTime(null)).toBe('');
        expect(relativeTime(undefined)).toBe('');
        expect(relativeTime('')).toBe('');
    });

    it('drops the unix epoch as if it were missing (wart: 0 is falsy, not "1 Jan 1970")', () => {
        expect(relativeTime(0)).toBe('');
    });

    it('says "just now" for anything under a minute', () => {
        expect(relativeTime(ago(0))).toBe('just now');
        expect(relativeTime(ago(59_000))).toBe('just now');
    });

    it('counts whole minutes from exactly one minute up to 59', () => {
        expect(relativeTime(ago(MINUTE))).toBe('1m ago');
        expect(relativeTime(ago(59 * MINUTE))).toBe('59m ago');
    });

    it('switches to hours at 60 minutes and to days at 24 hours', () => {
        expect(relativeTime(ago(60 * MINUTE))).toBe('1h ago');
        expect(relativeTime(ago(23 * HOUR + 59 * MINUTE))).toBe('23h ago');
        expect(relativeTime(ago(DAY))).toBe('1d ago');
        expect(relativeTime(ago(6 * DAY + 23 * HOUR))).toBe('6d ago');
    });

    it('switches to weeks at 7 days and never goes any coarser', () => {
        expect(relativeTime(ago(7 * DAY))).toBe('1w ago');
        expect(relativeTime(ago(35 * DAY))).toBe('5w ago');
        // Wart: no months and no years, so last year's run reads as "57w ago".
        expect(relativeTime(ago(400 * DAY))).toBe('57w ago');
    });

    it('calls a moment in the future "just now" (wart: negative differences fall through the first branch)', () => {
        expect(relativeTime(new Date(NOW.getTime() + HOUR).toISOString())).toBe('just now');
        expect(relativeTime(new Date(NOW.getTime() + 400 * DAY).toISOString())).toBe('just now');
    });

    it('renders an unparseable date as "NaNw ago" (wart: no validity check)', () => {
        expect(relativeTime('not-a-date')).toBe('NaNw ago');
        expect(relativeTime('2026-13-45')).toBe('NaNw ago');
    });

    it('accepts a Date instance as well as an ISO string', () => {
        expect(relativeTime(new Date(NOW.getTime() - 2 * HOUR))).toBe('2h ago');
    });

    it('is hard-coded English, with no hook for a translation (wart: CW-16/17)', () => {
        // Every branch, in one assertion: nothing here reaches i18n.
        expect([
            relativeTime(ago(0)),
            relativeTime(ago(5 * MINUTE)),
            relativeTime(ago(5 * HOUR)),
            relativeTime(ago(5 * DAY)),
            relativeTime(ago(50 * DAY)),
        ]).toEqual(['just now', '5m ago', '5h ago', '5d ago', '7w ago']);
    });
});

describe('formatDuration — "how long it took"', () => {
    it('gives an empty string for a missing duration', () => {
        expect(formatDuration(null)).toBe('');
        expect(formatDuration(undefined)).toBe('');
    });

    it('gives an empty string for something that is not a number at all', () => {
        expect(formatDuration('soon')).toBe('');
        expect(formatDuration(NaN)).toBe('');
        expect(formatDuration(Infinity)).toBe('');
    });

    it('is always minutes AND seconds, with the seconds in two digits (CW-16)', () => {
        expect(formatDuration(0)).toBe('0m 00s');
        expect(formatDuration(48_000)).toBe('0m 48s');
        expect(formatDuration(64_000)).toBe('1m 04s');
        expect(formatDuration(127_000)).toBe('2m 07s');
    });

    it('gives durations of the same order the same width, so a column of them lines up', () => {
        // The property the fixed shape exists for: these are read down a
        // 64px column, and a column you can compare by eye beats one you
        // have to parse. Under ten minutes every value is exactly "Xm YYs".
        const widths = new Set([0, 820, 5_200, 48_000, 64_000, 127_000, 540_000]
            .map(ms => formatDuration(ms).length));
        expect([...widths]).toEqual([6]);
    });

    it('rounds to whole seconds ONCE, so "1m 60s" and "60.0s" can no longer be printed', () => {
        expect(formatDuration(59_999)).toBe('1m 00s');
        expect(formatDuration(119_999)).toBe('2m 00s');
    });

    it('rounds a sub-second run down to no seconds — but keeps that apart from "not measured"', () => {
        expect(formatDuration(300)).toBe('0m 00s');
        expect(formatDuration(820)).toBe('0m 01s');
        // "It took less than a second" and "nobody timed it" are different
        // statements and must not collapse onto one string.
        expect(formatDuration(null)).toBe('');
    });

    it('clamps clock skew to zero instead of printing a negative duration at the reader', () => {
        expect(formatDuration(-5)).toBe('0m 00s');
        expect(formatDuration(-90_000)).toBe('0m 00s');
    });

    it('keeps counting minutes past the hour rather than inventing an hours unit', () => {
        // Deliberate: an hours unit is a WORD in some languages, and this
        // string has no translation hook. A long run is rare and readable.
        expect(formatDuration(3_600_000)).toBe('60m 00s');
        expect(formatDuration(7_200_000)).toBe('120m 00s');
    });

    it('carries no translatable word at all — "m" and "s" are SI symbols', () => {
        expect(formatDuration(65_000)).toMatch(/^\d+m \d{2}s$/);
    });
});

describe('fullTimestamp — "when", in the words someone would say out loud', () => {
    // NOW is Sunday 6 Sep 2026, 12:00 local. Five days back is a Tuesday —
    // the artboard's own example.
    const at = (daysAgo, h = 8, m = 0) => {
        const d = new Date(NOW);
        d.setDate(d.getDate() - daysAgo);
        d.setHours(h, m, 0, 0);
        return d;
    };
    const fmt = (value) => fullTimestamp(value, null, { now: NOW });

    it('gives an empty string for nothing at all, epoch included', () => {
        expect(fmt(null)).toBe('');
        expect(fmt(undefined)).toBe('');
        expect(fmt('')).toBe('');
        // Wart, unchanged: 0 is falsy, so the unix epoch reads as missing.
        expect(fmt(0)).toBe('');
    });

    it('says "Today" and "Yesterday" instead of a date (CW-16)', () => {
        expect(fmt(at(0).toISOString())).toBe('Today 08:00');
        expect(fmt(at(1).toISOString())).toBe('Yesterday 08:00');
    });

    it('names the weekday for the rest of the week', () => {
        const tuesday = fmt(at(5).toISOString());
        // Locale-independent half: a single capitalised word plus the clock,
        // and emphatically not the relative wording of the two days above.
        expect(tuesday).toMatch(/^\p{Lu}\p{L}+ 08:00$/u);
        expect(tuesday).not.toMatch(/Today|Yesterday/);
    });

    it.runIf(IS_EN_US)('reads "Tuesday 08:00" on an en-US host', () => {
        expect(fmt(at(5).toISOString())).toBe('Tuesday 08:00');
    });

    it('falls back to a date once the weekday would be ambiguous', () => {
        // Seven days back is the SAME weekday name as today, so "Sunday"
        // would be a lie about which Sunday.
        expect(fmt(at(7).toISOString())).toMatch(/^(\d+\s+\p{L}+|\p{L}+\s+\d+) 08:00$/u);
        expect(fmt(at(7).toISOString())).not.toMatch(/Today|Yesterday/);
    });

    it('adds the year only once the run is from another year', () => {
        // The old formatter never printed a year, so August 2025 and August
        // 2026 were the same line in a history list.
        expect(fmt(at(30).toISOString())).not.toMatch(/\d{4}/);
        const lastYear = new Date(2025, 7, 13, 8, 0);
        expect(fmt(lastYear.toISOString())).toMatch(/2025/);
    });

    it('is a 24-hour clock, never the AM/PM the schedules never use', () => {
        expect(fmt(at(0, 20, 30).toISOString())).toBe('Today 20:30');
        expect(fmt(at(0, 0, 5).toISOString())).toBe('Today 00:05');
        for (const value of [at(0), at(1), at(5), at(30)]) {
            expect(fmt(value.toISOString())).not.toMatch(/AM|PM/i);
        }
    });

    it('routes its two words through t(), under cowork.* keys', () => {
        const echo = (key) => `«${key}»`;
        expect(fullTimestamp(at(0).toISOString(), echo, { now: NOW }))
            .toBe('«cowork.history.today» 08:00');
        expect(fullTimestamp(at(1).toISOString(), echo, { now: NOW }))
            .toBe('«cowork.history.yesterday» 08:00');
    });

    it('returns an empty string for an unparseable value instead of printing "Invalid Date"', () => {
        expect(fmt('not-a-date')).toBe('');
        expect(fmt('2026-13-45')).toBe('');
    });

    it('accepts a Date instance as well as an ISO string', () => {
        expect(fmt(at(1))).toBe(fmt(at(1).toISOString()));
    });

    it('reads the real clock when no "now" is injected', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        try {
            expect(fullTimestamp(at(0).toISOString())).toBe('Today 08:00');
            expect(fullTimestamp(at(1).toISOString())).toBe('Yesterday 08:00');
        } finally {
            vi.useRealTimers();
        }
    });
});
