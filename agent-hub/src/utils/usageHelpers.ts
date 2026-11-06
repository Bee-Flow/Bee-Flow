// Helpers shared by the Usage & Monitoring dashboard surfaces.
//
// Lives outside UsageSection.jsx so the standalone Feedback / Terminations
// panels can import the same primitives without duplicating logic.

// ── CSV export ──────────────────────────────────────────────────────────────
// Minimal RFC 4180 escaping — enough for ≤ a few thousand audit rows.
//
// A cell that starts with = + - @ or a tab or carriage return is a formula to
// a spreadsheet that opens the file (DDE and the like), and these rows carry
// text other people typed (feedback, agent names). Such a cell gets a leading
// apostrophe, the same rule the server's CSV writers apply
// (server/routes/datatables/rowTransfer.js).

const FORMULA_START = /^[=+\-@\t\r]/;

function csvEscape(v: unknown): string {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (FORMULA_START.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
    return lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** The range model the picker holds. */
export interface RangeInput {
    preset?: string;
    customStart?: string | number | Date | null;
    customEnd?: string | number | Date | null;
}

/** A range in every shape the usage endpoints ask for. */
export interface RangeParams {
    days: number | null;
    startDate: string | null;
    endDate: string | null;
    interval: 'hour' | 'day';
}

// ── Unified date range adapter ──────────────────────────────────────────────
// One range model `{ preset, customStart, customEnd }` drives all five tabs.
// `deriveRangeParams` turns it into every shape the heterogeneous endpoints
// need at once, so each consumer picks the pair its route understands:
//   • usage family  → `?days=N`  (and, once the backend tweak ships, startDate/endDate)
//   • feedback      → `?startDate&endDate`  (omit both = all-time)
//   • terminations  → `?days=N` | `?startDate&endDate` (+ `interval`); omit = all-time
//
// `days` is null for the 'all' preset (truly unbounded); consumers that can
// only express a day count fall back to a large bound (see USAGE_ALL_DAYS).
export const USAGE_ALL_DAYS = 3650; // ~10y — "all" fallback for days-only routes

export function deriveRangeParams(range?: RangeInput | null): RangeParams {
    const { preset, customStart, customEnd } = range || {};
    const DAY = 86400000;
    const now = new Date();
    const iso = (d: string | number | Date): string => new Date(d).toISOString();
    const ago = (ms: number): string => iso(new Date(now.getTime() - ms));
    const startOfToday = () => { const d = new Date(now); d.setHours(0, 0, 0, 0); return iso(d); };

    switch (preset) {
        case 'today':
            return { days: 1, startDate: startOfToday(), endDate: iso(now), interval: 'hour' };
        case '24h':
            return { days: 1, startDate: ago(DAY), endDate: iso(now), interval: 'hour' };
        case '7d':
            return { days: 7, startDate: ago(7 * DAY), endDate: iso(now), interval: 'day' };
        case '30d':
            return { days: 30, startDate: ago(30 * DAY), endDate: iso(now), interval: 'day' };
        case '90d':
            return { days: 90, startDate: ago(90 * DAY), endDate: iso(now), interval: 'day' };
        case 'all':
            return { days: null, startDate: null, endDate: null, interval: 'day' };
        case 'custom': {
            if (customStart && customEnd) {
                const s = new Date(customStart), e = new Date(customEnd);
                const span = Math.max(0, e.getTime() - s.getTime());
                return {
                    days: Math.max(1, Math.ceil(span / DAY)),
                    startDate: iso(s),
                    endDate: iso(e),
                    interval: span <= DAY ? 'hour' : 'day',
                };
            }
            return { days: 30, startDate: null, endDate: null, interval: 'day' };
        }
        default:
            return { days: 30, startDate: ago(30 * DAY), endDate: iso(now), interval: 'day' };
    }
}

// ── Model → tier mapping ────────────────────────────────────────────────────
// Usage/termination rows carry `model` but no tier. `/ai/config/tiers-for-user`
// returns `{ tierKey: { modelId } | modelId }`; invert it once so the cloud
// view can badge each row's model with its configured tier. Unknown models
// fall back to no tier (model-only badge).
export function buildModelTierMap(tiersForUser?: Record<string, string | { modelId?: string | null } | null | undefined> | null): Record<string, string> {
    const map: Record<string, string> = {};
    if (tiersForUser && typeof tiersForUser === 'object') {
        for (const [tier, val] of Object.entries(tiersForUser)) {
            const modelId = typeof val === 'string' ? val : (val && val.modelId);
            if (modelId) map[modelId] = tier;
        }
    }
    return map;
}

export function tierForModel(map?: Record<string, string> | null, model?: string | null): string | null {
    if (!map || !model) return null;
    return map[model] || null;
}
