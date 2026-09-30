/**
 * Numbers, dates and "how long ago" in the app's language, not the phone's.
 *
 * `toLocaleString(undefined)` formats in the DEVICE's locale, and
 * `toLocaleString('en-US')` in nobody's: a Dutch workspace on an English phone
 * read "2,500" beside "Bijgewerkt", and an English chart axis read "Mar" in a
 * Dutch app. Everything here formats in `currentLocale()` — the language the
 * rest of the screen is rendered in — so a number, a date and the sentence
 * around them always agree.
 *
 * Pure functions over the module-level store (like `translate`), so a model
 * file can call them. A component that does must also call
 * `useTranslation()`, which is what re-renders it when the locale changes.
 */

import { currentLocale, translate } from './store';

/**
 * Build with the app's locale; a code Intl has no data for falls back to
 * English instead of throwing out of a render. An invalid OPTION (an unknown
 * currency) still throws — from the English retry — so a caller that passes
 * one can say what it wants instead.
 */
function inLocale<T>(make: (locale: string) => T): T {
    const locale = currentLocale();
    try {
        return make(locale);
    } catch (err) {
        if (!(err instanceof RangeError) || locale === 'en') throw err;
        return make('en');
    }
}

function toDate(value: string | number | Date | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A number as the app's language writes it: "2.500" and "2,5" in Dutch, "2,500" and "2.5" in English. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return inLocale((locale) => new Intl.NumberFormat(locale, options).format(value));
}

/**
 * A date as the app's language writes it — "12 mrt 2026" / "Mar 12, 2026" by
 * default. Missing or unparseable input is '', for the same reason
 * `relativeTime` returns it: it lands in meta slots, where "Invalid Date" is
 * worse than nothing.
 */
export function formatDate(
    value: string | number | Date | null | undefined,
    options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string {
    const d = toDate(value);
    if (!d) return '';
    return inLocale((locale) => new Intl.DateTimeFormat(locale, options).format(d));
}

/**
 * "12 Aug, 14:03" — the web's `formatWhen` (agent-hub Approvals/
 * approvalDisplay.js), in the app's language: short for a row, unambiguous
 * for a deadline or an audit line. The year appears once it is not this
 * year's. Missing input is an em dash, as on the web.
 */
export function formatWhen(value: string | number | Date | null | undefined, now = Date.now()): string {
    const d = toDate(value);
    if (!d) return '—';
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return formatDate(d, {
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * "12 Mar", or "12 Mar 2025" once it is not this year — a day with no clock,
 * in the app's language. Missing input is '', like `formatDate`.
 */
export function formatDay(value: string | number | Date | null | undefined, now = Date.now()): string {
    const d = toDate(value);
    if (!d) return '';
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return formatDate(d, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Calendar days from `now` to `d` on the device's calendar: 0 today, 1 tomorrow, -1 yesterday. */
function dayOffset(d: Date, now: number): number {
    const n = new Date(now);
    const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const today = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
    return Math.round((day - today) / 86_400_000);
}

/**
 * "Today at 09:00", "Tomorrow at 09:00", "Yesterday at 09:00", "12 Mar at
 * 09:00" — the web's formatNextRun (agent-hub automation/taskFormatters.js),
 * in the app's language. Each phrase is ONE sentence with a `{time}` slot
 * rather than a translated "Today" glued to a clock, so a translation can put
 * the time where its grammar wants it. The clock and the date are the app
 * language's too; the year appears once it is not this year's. Missing input
 * is an em dash, as with `formatWhen`.
 */
export function formatMoment(value: string | number | Date | null | undefined, now = Date.now()): string {
    const d = toDate(value);
    if (!d) return '—';
    const time = formatDate(d, { hour: '2-digit', minute: '2-digit' });
    const offset = dayOffset(d, now);
    if (offset === 0) return translate('mobile.time.today_at', 'Today at {time}', { time });
    if (offset === 1) return translate('mobile.time.tomorrow_at', 'Tomorrow at {time}', { time });
    if (offset === -1) return translate('mobile.time.yesterday_at', 'Yesterday at {time}', { time });
    return translate('mobile.time.date_at', '{date} at {time}', { date: formatDay(d, now), time });
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 7 * DAY;

/**
 * How far ahead of the device a timestamp may be and still read as "now": a
 * server clock a little ahead is a clock problem, not a future event. The
 * same slack as `relativeTime` in shared/lib/time.ts (format.test.ts holds
 * the two together).
 */
export const FUTURE_SLACK_SECONDS = 5 * MINUTE;

export interface TimeAgoOptions {
    /** A phrase ("5m ago", "just now") rather than a bare meta token ("5m", "now"). */
    suffix?: boolean;
}

/**
 * `relativeTime` (shared/lib/time.ts) in the app's language: the same
 * thresholds, floored the same way, a date after a week — but its words come
 * from the catalogue. The phrase form borrows the web's own `time.*` keys
 * (agent-hub hooks/useRelativeTime.ts), so "Bijgewerkt 5m ago" becomes one
 * language; the bare tokens have no web twin and use `mobile.time.*`.
 *
 * A timestamp clearly in the FUTURE returns '' rather than "now": a deadline
 * is not an age, and "Expires: now" on something with a week left is the bug
 * this refusal exists to catch. Say a deadline with `formatWhen`.
 */
export function timeAgo(
    value: string | number | Date | null | undefined,
    options: TimeAgoOptions = {},
    now = Date.now(),
): string {
    const d = toDate(value);
    if (!d) return '';
    const elapsed = (now - d.getTime()) / 1000;
    if (elapsed < -FUTURE_SLACK_SECONDS) {
        if (__DEV__) console.warn(`[i18n] timeAgo got a future time (${d.toISOString()}); a deadline wants formatWhen`);
        return '';
    }
    const seconds = Math.max(0, elapsed);
    const phrase = options.suffix === true;
    if (seconds < MINUTE) return phrase ? translate('time.just_now', 'just now') : translate('mobile.time.now', 'now');
    if (seconds < HOUR) return count(phrase, 'minutes', Math.floor(seconds / MINUTE));
    if (seconds < DAY) return count(phrase, 'hours', Math.floor(seconds / HOUR));
    if (seconds < WEEK) return count(phrase, 'days', Math.floor(seconds / DAY));
    return formatDay(d, now);
}

function count(phrase: boolean, unit: 'minutes' | 'hours' | 'days', n: number): string {
    if (unit === 'minutes') {
        return phrase ? translate('time.minutes_ago', '{count}m ago', { count: n }) : translate('mobile.time.minutes', '{count}m', { count: n });
    }
    if (unit === 'hours') {
        return phrase ? translate('time.hours_ago', '{count}h ago', { count: n }) : translate('mobile.time.hours', '{count}h', { count: n });
    }
    return phrase ? translate('time.days_ago', '{count}d ago', { count: n }) : translate('mobile.time.days', '{count}d', { count: n });
}
