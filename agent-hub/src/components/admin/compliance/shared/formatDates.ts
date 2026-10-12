import { useMemo } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { formatCalDate, parseDay, resolveNow } from './calendarMath';

/**
 * formatDates: the ONE way the Compliance Center writes a date.
 *
 * The registers used to print dates six ways ("19-8-2026", "Aug 19, 2026",
 * "2026-08-19", "19 Aug", "19 aug. 20:38", "19/08/2026, 20:38:05"), half of
 * them in the BROWSER's locale rather than the app's. Three shapes are left:
 *
 *   formatDay      "19 Aug"            a date; the year is added when it is
 *                  "3 Mar 2025"        not the current year
 *   formatDayTime  "19 Aug 20:38"      a moment; always 24-hour
 *   formatStamp    "19 Aug 20:38:05"   a log line (the Access log), with seconds
 *
 * The day part is calendarMath.formatCalDate (day first in every language,
 * three-letter English months, no ICU period after "aug."), the one formatter
 * that already got all of that right. The time part is plain digits: 24-hour
 * clock time reads the same in every language this product ships.
 *
 * `locale` is the APP's language (useTranslation's resolvedLocale, the
 * language actually on screen); `useDateFormat()` binds it. Anything that is
 * not a date gives ''.
 */

export type DateLike = string | number | Date | null | undefined;

const ISO_DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function instant(value: DateLike): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms) : null;
}

/** A bare 'YYYY-MM-DD' names a day, not a moment: it has no time to print. */
function isDayOnly(value: DateLike): boolean {
    return typeof value === 'string' && ISO_DAY_ONLY.test(value.trim());
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "19 Aug", or "3 Mar 2025" when the year is not the current one. */
export function formatDay(value: DateLike, locale = 'en', now: number | Date = Date.now()): string {
    const day = parseDay(value);
    if (day === null) return '';
    const nowMs = resolveNow(now);
    const sameYear = new Date(day).getFullYear() === new Date(nowMs).getFullYear();
    return formatCalDate(value, { locale, now: nowMs, year: sameYear ? 'never' : 'always' });
}

/** "19 Aug 20:38" (24-hour); a bare 'YYYY-MM-DD' prints only its day. */
export function formatDayTime(value: DateLike, locale = 'en', now: number | Date = Date.now()): string {
    const day = formatDay(value, locale, now);
    if (!day || isDayOnly(value)) return day;
    const d = instant(value);
    return d ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** "19 Aug 20:38:05": a log line, to the second. */
export function formatStamp(value: DateLike, locale = 'en', now: number | Date = Date.now()): string {
    const day = formatDay(value, locale, now);
    if (!day || isDayOnly(value)) return day;
    const d = instant(value);
    return d ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : day;
}

export interface DateFormat {
    locale: string;
    formatDay: (value: DateLike) => string;
    formatDayTime: (value: DateLike) => string;
    formatStamp: (value: DateLike) => string;
}

/** The three formatters bound to the language on screen. */
export function useDateFormat(): DateFormat {
    const { resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    return useMemo(() => ({
        locale,
        formatDay: (value: DateLike) => formatDay(value, locale),
        formatDayTime: (value: DateLike) => formatDayTime(value, locale),
        formatStamp: (value: DateLike) => formatStamp(value, locale),
    }), [locale]);
}
