/**
 * The period the answers dashboard looks at — a port of the web's
 * Studio/Forms/answers/answersRange.js, run beside it by
 * answersRange.lockstep.test.ts. Calendar days, inclusive, in the viewer's
 * local time; `all` sends no bounds at all.
 */

export const PRESETS = Object.freeze(['today', '7d', '30d', '90d', 'all', 'custom'] as const);
export type RangePreset = (typeof PRESETS)[number];

export interface AnswersRange {
    preset: RangePreset;
    /** YYYY-MM-DD, for `custom` only. */
    from: string;
    to: string;
}

const DAY_MS = 86400000;

function isoDay(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function defaultRange(): AnswersRange {
    return { preset: '30d', from: '', to: '' };
}

const DAYS: Readonly<Record<string, number>> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
const isDay = (v: string | null | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

/** `{ from, to }` as YYYY-MM-DD strings (or nulls for `all`). */
export function rangeToQuery(range: Partial<AnswersRange> | null | undefined, now: Date = new Date()): { from: string | null; to: string | null } {
    const preset = PRESETS.includes(range?.preset as RangePreset) ? (range?.preset as RangePreset) : '30d';
    if (preset === 'all') return { from: null, to: null };
    if (preset === 'custom') {
        return { from: isDay(range?.from) ? (range?.from as string) : null, to: isDay(range?.to) ? (range?.to as string) : null };
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = DAYS[preset] ?? 30;
    return { from: isoDay(new Date(today.getTime() - (days - 1) * DAY_MS)), to: isoDay(today) };
}
