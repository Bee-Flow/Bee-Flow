/**
 * The regulatory calendar's date arithmetic, ported from the web's
 * shared/calendarMath.js (pinned by calendarMath.test.ts, differential).
 *
 * GET /calendar returns 'YYYY-MM-DD' dates (null when uncertain) and leaves
 * TODAY to the client. A day string is parsed as LOCAL midnight: `new
 * Date('2026-12-02')` is UTC midnight, the previous day in any zone west of
 * UTC. Past = before today; upcoming = today or later;
 * uncertain = no date or kind 'uncertain'. Within 90 days the countdown is
 * in days and in warning ink, beyond it in months.
 */

export const DAY_MS = 86_400_000;

/** Days at or under which a milestone counts as "soon" (warning ink, day units). */
export const SOON_DAYS = 90;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DayInput = string | number | Date | null | undefined;

/** Local midnight of the day `ms` falls in. */
export function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A milestone date as local-midnight ms; null for anything that is not a date. */
export function parseDay(value: DayInput): number | null {
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

/** `now` as epoch ms: a Date, a number, or anything else → the real clock. */
export function resolveNow(now?: number | Date | null): number {
    if (now === null || now === undefined) return Date.now();
    const ms = now instanceof Date ? now.getTime() : Number(now);
    return Number.isFinite(ms) ? ms : Date.now();
}

/** Whole days from today (local) to the date: negative = past, 0 = today. */
export function daysUntil(date: DayInput, now: number | Date = Date.now()): number | null {
    const target = parseDay(date);
    if (target === null) return null;
    return Math.round((target - startOfDay(resolveNow(now))) / DAY_MS);
}

export interface DatedLike {
    date?: string | null;
    kind?: string | null;
}

const isUncertain = (m: DatedLike) => m.kind === 'uncertain' || parseDay(m.date) === null;

/** Split on today: past and upcoming by date ascending, uncertain in input order. */
export function splitByToday<T extends DatedLike>(milestones: readonly T[] | null | undefined, now: number | Date = Date.now()) {
    const past: T[] = [];
    const upcoming: T[] = [];
    const uncertain: T[] = [];
    for (const m of Array.isArray(milestones) ? milestones : []) {
        if (!m || typeof m !== 'object') continue;
        if (isUncertain(m)) {
            uncertain.push(m);
            continue;
        }
        ((daysUntil(m.date, now) ?? 0) < 0 ? past : upcoming).push(m);
    }
    const byDate = (a: T, b: T) => (parseDay(a.date) ?? 0) - (parseDay(b.date) ?? 0);
    past.sort(byDate);
    upcoming.sort(byDate);
    return { past, upcoming, uncertain };
}

export type Countdown = { unit: 'today' | 'days' | 'months'; n: number; soon: boolean };

/** How far away an upcoming date is; null for the past or no date. */
export function countdown(days: number | null | undefined): Countdown | null {
    if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;
    if (days === 0) return { unit: 'today', n: 0, soon: true };
    if (days <= SOON_DAYS) return { unit: 'days', n: days, soon: true };
    return { unit: 'months', n: Math.max(1, Math.round(days / 30.44)), soon: false };
}

/** The tag Intl gets: plain 'en' formats day-first, as en-GB. */
export function intlLocale(locale: string | null | undefined): string {
    if (!locale || typeof locale !== 'string') return 'en-GB';
    return locale === 'en' ? 'en-GB' : locale;
}

export interface CalDateOptions {
    locale?: string;
    now?: number | Date;
    year?: 'always' | 'auto' | 'never';
}

const EN_US_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });

function dayFormat(tag: string, withYear: boolean): Intl.DateTimeFormat {
    const opts: Intl.DateTimeFormatOptions = withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' };
    try {
        return new Intl.DateTimeFormat(tag, opts);
    } catch {
        return new Intl.DateTimeFormat('en-GB', opts);
    }
}

/** "2 Dec 2026" (always), "2 Dec" / "12 Jan '27" (auto), "2 Dec" (never). */
export function formatCalDate(date: DayInput, { locale = 'en', now = Date.now(), year = 'always' }: CalDateOptions = {}): string {
    const ms = parseDay(date);
    if (ms === null) return '';
    const tag = intlLocale(locale);
    const d = new Date(ms);
    const english = /^en(-|$)/i.test(tag);
    let out = dayFormat(tag, year === 'always')
        .formatToParts(d)
        .map((part) => (part.type === 'month' && english ? EN_US_MONTH.format(d) : part.value))
        .join('')
        .replace(/(?<=\p{L})\.(?=\s|$)/gu, '');
    if (year === 'auto' && d.getFullYear() !== new Date(resolveNow(now)).getFullYear()) {
        out += ` '${String(d.getFullYear()).slice(-2)}`;
    }
    return out;
}
