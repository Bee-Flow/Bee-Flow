/**
 * When a meeting is: parsing, length, time range and the date block. A port
 * of agent-hub pages/meeting-notes/lib/upcomingWhen.js, held to it by
 * when.lockstep.test.ts, which runs both on the same fixtures.
 *
 * `null` means UNKNOWN throughout, never "now" and never zero. An all-day
 * event arrives from both providers as a bare date ("2026-07-18"), which
 * `new Date()` reads as UTC midnight — a day early anywhere west of
 * Greenwich — so it is parsed as LOCAL midnight and marked `dateOnly`.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface When {
    date: Date;
    dateOnly: boolean;
}

export function parseWhen(value: unknown): When | null {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, dateOnly: false };
    const s = String(value).trim();
    if (!s) return null;
    if (DATE_ONLY_RE.test(s)) {
        const [y, m, d] = s.split('-').map(Number) as [number, number, number];
        const date = new Date(y, m - 1, d);
        return Number.isNaN(date.getTime()) ? null : { date, dateOnly: true };
    }
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
}

/** Whole minutes, or null: a missing side, an all-day event, or an end not after the start. */
export function meetingDurationMinutes(start: unknown, end: unknown): number | null {
    const s = parseWhen(start);
    const e = parseWhen(end);
    if (!s || !e) return null;
    if (s.dateOnly || e.dateOnly) return null;
    const minutes = Math.round((e.date.getTime() - s.date.getTime()) / 60000);
    return minutes > 0 ? minutes : null;
}

/** "Thu 12 Sep" in pieces for the date block, or null without a start. */
export function dateBlockParts(start: unknown): { weekday: string; day: string; month: string } | null {
    const when = parseWhen(start);
    if (!when) return null;
    return {
        weekday: when.date.toLocaleDateString(undefined, { weekday: 'short' }),
        day: when.date.toLocaleDateString(undefined, { day: 'numeric' }),
        month: when.date.toLocaleDateString(undefined, { month: 'short' }),
    };
}

const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "14:00–15:00", "14:00", or '' — an all-day event has no time range. */
export function timeRange(start: unknown, end: unknown): string {
    const s = parseWhen(start);
    if (!s || s.dateOnly) return '';
    const e = parseWhen(end);
    return e && !e.dateOnly ? `${hhmm(s.date)}–${hhmm(e.date)}` : hhmm(s.date);
}
