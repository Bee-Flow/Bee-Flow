/**
 * Days and times for the "What happened" pane.
 *
 * ONE day definition for the whole pane: the viewer's local calendar day.
 * The bars, the day filter, the log's day headers and the period title all
 * use it, so a row never sits under one date in the log and in another bar
 * of the chart. (The server's own timeline groups by the database's day,
 * which is why the chart is drawn from the rows rather than from it.)
 *
 * Pure: the locale is passed in, nothing reads the clock except `today`
 * defaults, and every function returns something printable for bad input.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function toDate(value: string | number | Date | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
}

/** A timestamp → its local calendar day as `YYYY-MM-DD`, or null when unparseable. */
export function dayKey(ts: string | number | Date | null | undefined): string | null {
    const d = toDate(ts);
    if (!d) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A timestamp → `HH:MM` on the local clock, or '' when unparseable. */
export function clockTime(ts: string | number | Date | null | undefined): string {
    const d = toDate(ts);
    return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** `YYYY-MM-DD` → local midnight of that day. */
export function dayStart(key: string): Date {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * Every local day from `start` to `end`, both included, oldest first.
 *
 * A "30 days" window that starts at 17:00 touches 31 calendar days, and every
 * one of them can hold a row, so all of them get a bar. Capped at 400 days so
 * a malformed window cannot build an unbounded axis.
 */
export function daySpan(start: string | Date | null | undefined, end: string | Date | null | undefined): string[] {
    const from = toDate(start);
    const to = toDate(end);
    if (!from || !to || to < from) return [];
    const out: string[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const last = dayKey(to);
    for (let i = 0; i < 400; i += 1) {
        const key = dayKey(cursor) as string;
        out.push(key);
        if (key === last) break;
        cursor.setDate(cursor.getDate() + 1);
    }
    return out;
}

/**
 * The app's plain `en` reads dates the European way here ("28 Sep"), like the
 * compliance calendar does: the product and its admins are EU-first, and the
 * US order would be the odd one out on this screen.
 */
export function intlLocale(locale: string | null | undefined): string {
    if (!locale) return 'en-GB';
    return locale === 'en' ? 'en-GB' : locale;
}

/**
 * `YYYY-MM-DD` → "28 Sep", or "Mon 28 Sep" with the weekday. The comma some
 * locales put after the weekday is dropped: this is a compact label, not a
 * sentence.
 */
export function formatDay(key: string, locale: string, { weekday = false } = {}): string {
    try {
        const fmt = new Intl.DateTimeFormat(intlLocale(locale), weekday
            ? { weekday: 'short', day: 'numeric', month: 'short' }
            : { day: 'numeric', month: 'short' });
        return fmt.formatToParts(dayStart(key))
            .map(p => (p.type === 'literal' ? p.value.replace(',', '') : p.value))
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
    } catch {
        return key;
    }
}

/** The period title: "30 Aug – 28 Sep 2026" (the locale decides the order and the dash). */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined, locale: string): string {
    const from = toDate(start);
    const to = toDate(end);
    if (!from || !to) return '';
    const fmt = new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'short', year: 'numeric' });
    try {
        return fmt.formatRange(from, to);
    } catch {
        return `${fmt.format(from)} – ${fmt.format(to)}`;
    }
}

/** A full timestamp for the evidence panel, in the viewer's locale. */
export function formatStamp(ts: string | null | undefined, locale: string): string {
    const d = toDate(ts);
    if (!d) return '';
    try {
        return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'medium' }).format(d);
    } catch {
        return d.toISOString();
    }
}
