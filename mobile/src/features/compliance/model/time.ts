/**
 * The Compliance Center's three date shapes, in the APP's language: port of
 * agent-hub/src/components/admin/compliance/shared/formatDates.ts (with the
 * calendarMath.js helpers it stands on), pinned by a differential test.
 *
 *   formatDay      "19 Aug" / "3 Mar 2025"  the year only when it is not this year
 *   formatDayTime  "19 Aug 20:38"           a moment, 24-hour
 *   formatStamp    "19 Aug 20:38:05"        a log line, to the second
 *
 * Plus the local-day helpers the day and moment pickers use.
 */

import { currentLocale } from '@/core/i18n';

import { addCalendarMonths } from './deadlineMath';

export type DateLike = string | number | Date | null | undefined;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A day as local-midnight ms: 'YYYY-MM-DD' (round-tripped), a Date, an ISO stamp or epoch ms. */
export function parseDay(value: DateLike): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
        const m = ISO_DAY.exec(value.trim());
        if (m) {
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            if (Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
            return d.getTime();
        }
    }
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? startOfDay(ms) : null;
}

/** Plain English is day-first here ("2 Dec"), so 'en' formats as en-GB. */
function intlLocale(locale: string): string {
    return !locale ? 'en-GB' : locale === 'en' ? 'en-GB' : locale;
}

function dayFormat(tag: string, withYear: boolean): Intl.DateTimeFormat {
    const options: Intl.DateTimeFormatOptions = withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' };
    try {
        return new Intl.DateTimeFormat(tag, options);
    } catch {
        return new Intl.DateTimeFormat('en-GB', options);
    }
}

/** English months are three letters ("Sep", never "Sept"): taken from en-US. */
function monthWord(tag: string, value: string, d: Date): string {
    if (!/^en(-|$)/i.test(tag)) return value;
    return new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d);
}

/** The period ICU puts after some month abbreviations ("dec.") goes; a digit's stays. */
const MONTH_PERIOD = /([A-Za-zÀ-ɏͰ-ϿЀ-ӿ])\.(?=\s|$)/g;

function formatCalDate(ms: number, locale: string, withYear: boolean): string {
    const tag = intlLocale(locale);
    const d = new Date(ms);
    return dayFormat(tag, withYear)
        .formatToParts(d)
        .map((part) => (part.type === 'month' ? monthWord(tag, part.value, d) : part.value))
        .join('')
        .replace(MONTH_PERIOD, '$1');
}

/** "19 Aug", or "3 Mar 2025" when the year is not the current one. '' for no date. */
export function formatDay(value: DateLike, locale: string = currentLocale(), now: number = Date.now()): string {
    const day = parseDay(value);
    if (day === null) return '';
    const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();
    return formatCalDate(day, locale, !sameYear);
}

const isDayOnly = (value: DateLike) => typeof value === 'string' && ISO_DAY.test(value.trim());
const pad = (n: number) => String(n).padStart(2, '0');

function instant(value: DateLike): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms) : null;
}

/** "19 Aug 20:38" (24-hour); a bare 'YYYY-MM-DD' prints only its day. */
export function formatDayTime(value: DateLike, locale: string = currentLocale(), now: number = Date.now()): string {
    const day = formatDay(value, locale, now);
    if (!day || isDayOnly(value)) return day;
    const d = instant(value);
    return d ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** "19 Aug 20:38:05": a log line, to the second. */
export function formatStamp(value: DateLike, locale: string = currentLocale(), now: number = Date.now()): string {
    const day = formatDay(value, locale, now);
    if (!day || isDayOnly(value)) return day;
    const d = instant(value);
    return d ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : day;
}

/** A local day as 'YYYY-MM-DD'. */
export function isoDay(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A 'YYYY-MM-DD' (or today, when it is not one) moved by whole days. */
export function shiftDay(value: string, days: number, now: number = Date.now()): string {
    const base = new Date(parseDay(value) ?? startOfDay(now));
    base.setDate(base.getDate() + days);
    return isoDay(base.getTime());
}

/** Today plus whole calendar months, the end clamped to the month's last day. */
export function addMonthsDay(now: number, months: number): string {
    const today = isoDay(now);
    const ms = addCalendarMonths(`${today}T00:00:00Z`, months);
    return ms === null ? today : new Date(ms).toISOString().slice(0, 10);
}
