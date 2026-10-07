/**
 * GET /api/compliance/calendar[?all=1] (server/routes/compliance/calendar.js):
 * `{ milestones: [{ id, date|null, framework_id, kind, label_key, detail_key,
 * relevant, affects|null, expected }], today_hint: null }`. By default the
 * relevant and uncertain milestones; `all=1` every one with its `relevant`
 * flag. The client draws TODAY (model/calendarMath.ts).
 */

import { api } from '@/core/api/client';
import { field, pick, shapeOf } from '@/core/api/contract';

import { COMPLIANCE } from '../model/paths';

const str = field.strOrNull;

/** `affects` counts (automations, agents, webpages, forms…); non-numbers dropped, null when absent. */
function counts(v: unknown): Record<string, number> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) {
        const num = field.numOrNull(n);
        if (num !== null) out[k] = num;
    }
    return out;
}

const readMilestone = shapeOf({
    id: str,
    date: str,
    framework_id: str,
    kind: str,
    label_key: str,
    label: str,
    detail_key: str,
    detail: str,
    relevant: field.optBool,
    affects: counts,
    expected: str,
});
export type Milestone = ReturnType<typeof readMilestone>;

/** The calendar answer: its milestones, rows that are not objects dropped. */
export function readCalendar(raw: unknown): { milestones: Milestone[] } {
    const rows = pick(raw, 'milestones');
    return {
        milestones: Array.isArray(rows) ? rows.filter((r) => r !== null && typeof r === 'object').map(readMilestone) : [],
    };
}

export const calendarKeys = {
    calendar: (all: boolean) => ['compliance', 'calendar', all] as const,
};

export async function getCalendar(all = false, signal?: AbortSignal) {
    const raw = await api.get<unknown>(`${COMPLIANCE}/calendar`, { signal, query: all ? { all: '1' } : undefined });
    return readCalendar(raw);
}
