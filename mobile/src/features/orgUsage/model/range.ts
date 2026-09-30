/**
 * The dashboard's one date range, turned into what each family of endpoints
 * understands — a port of the web's deriveRangeParams (utils/usageHelpers.js)
 * and RangeControl's presets. The phone offers every preset except Custom
 * (no date-time picker here).
 *
 *   usage family  → ?days=N (+ startDate/endDate when known; 'all' → 3650 days)
 *   feedback      → ?startDate&endDate, or nothing for all time (strict schema)
 *   terminations  → ?startDate&endDate, or nothing for all time (+ interval)
 */

export const RANGE_PRESETS = ['today', '24h', '7d', '30d', '90d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface RangeParams {
    days: number | null;
    startDate: string | null;
    endDate: string | null;
    interval: 'hour' | 'day';
}

/** "All" on a route that only takes a day count (USAGE_ALL_DAYS). */
export const USAGE_ALL_DAYS = 3650;

const DAY = 86_400_000;

export function isRangePreset(value: unknown): value is RangePreset {
    return typeof value === 'string' && (RANGE_PRESETS as readonly string[]).includes(value);
}

export function deriveRangeParams(preset: RangePreset, now: Date = new Date()): RangeParams {
    const iso = (d: Date) => d.toISOString();
    const ago = (ms: number) => iso(new Date(now.getTime() - ms));
    switch (preset) {
        case 'today': {
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            return { days: 1, startDate: iso(start), endDate: iso(now), interval: 'hour' };
        }
        case '24h':
            return { days: 1, startDate: ago(DAY), endDate: iso(now), interval: 'hour' };
        case '7d':
            return { days: 7, startDate: ago(7 * DAY), endDate: iso(now), interval: 'day' };
        case '90d':
            return { days: 90, startDate: ago(90 * DAY), endDate: iso(now), interval: 'day' };
        case 'all':
            return { days: null, startDate: null, endDate: null, interval: 'day' };
        default:
            return { days: 30, startDate: ago(30 * DAY), endDate: iso(now), interval: 'day' };
    }
}

type Query = Record<string, string | number>;

/** `/api/usage/*`: always a day count, plus the exact window when there is one. */
export function usageQuery(p: RangeParams): Query {
    const q: Query = { days: p.days ?? USAGE_ALL_DAYS };
    if (p.startDate && p.endDate) {
        q.startDate = p.startDate;
        q.endDate = p.endDate;
    }
    return q;
}

/** `/api/feedback/org*` and `/api/terminations/org*`: the window, or nothing for all time. */
export function windowQuery(p: RangeParams): Query {
    return p.startDate && p.endDate ? { startDate: p.startDate, endDate: p.endDate } : {};
}
