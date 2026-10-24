/**
 * When a meeting is: parsing, duration, time window and the date block.
 *
 * ── WHY THIS IS SEPARATE FROM upcomingMeta.js ───────────────────────
 * This file deliberately has NO imports. The whole-day rule below can only be tested in a time zone with a NEGATIVE offset — in UTC the good and the bad implementation give the same answer, so an assertion that runs in the container (TZ=UTC) does not hold the fix back. `upcomingWhen.test.js` therefore also runs this module in a child process under TZ=America/New_York, and that is only possible if the file can be imported without a bundler.
 *
 * `upcomingMeta.js` re-exports everything here, so callers notice nothing.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What a calendar payload carries for a moment: an ISO string, a Date, or nothing. */
export type WhenInput = string | Date | null | undefined;

export interface ParsedWhen {
    date: Date;
    dateOnly: boolean;
}

export interface DateBlockParts {
    weekday: string;
    day: string;
    month: string;
}

/**
 * One calendar moment. Gives `{ date, dateOnly }`, or NULL if nothing usable is stated — `null` here means "unknown", never "now".
 *
 * A whole-day appointment arrives at both providers as a bare DATE ("2026-07-18"; gmeetCalendar falls back to `start.date`). `new Date()` reads that as UTC midnight, which in a negative time zone puts it a day too early on the screen. Therefore we parse it as LOCAL midnight and mark it `dateOnly`: there is a day in it, not a time of day.
 */
export function parseWhen(value: WhenInput): ParsedWhen | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, dateOnly: false };
    const s = String(value).trim();
    if (!s) return null;
    if (DATE_ONLY_RE.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        return Number.isNaN(date.getTime()) ? null : { date, dateOnly: true };
    }
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
}

/**
 * The duration in whole minutes, or NULL if we do not know it. Unknown stays unknown with: a missing or unreadable side, a whole-day appointment (a date is not a length), and an end that does not lie after the start.
 */
export function meetingDurationMinutes(start: WhenInput, end: WhenInput): number | null {
    const s = parseWhen(start);
    const e = parseWhen(end);
    if (!s || !e) return null;
    if (s.dateOnly || e.dateOnly) return null;
    const minutes = Math.round((e.date.getTime() - s.date.getTime()) / 60000);
    return minutes > 0 ? minutes : null;
}

/** `do 12 sep` in stukken voor het datumblok, of NULL zonder begintijd. */
export function dateBlockParts(start: WhenInput): DateBlockParts | null {
    const when = parseWhen(start);
    if (!when) return null;
    return {
        weekday: when.date.toLocaleDateString(undefined, { weekday: 'short' }),
        day: when.date.toLocaleDateString(undefined, { day: 'numeric' }),
        month: when.date.toLocaleDateString(undefined, { month: 'short' }),
    };
}

const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** `14:00–15:00`, `14:00`, or '' — a whole day has no time window. */
export function timeRange(start: WhenInput, end: WhenInput): string {
    const s = parseWhen(start);
    if (!s || s.dateOnly) return '';
    const e = parseWhen(end);
    return e && !e.dateOnly ? `${hhmm(s.date)}–${hhmm(e.date)}` : hhmm(s.date);
}
