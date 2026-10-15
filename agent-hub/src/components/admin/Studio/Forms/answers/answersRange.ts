/**
 * The period a dashboard looks at — pure, so the Range control and the
 * fetch agree on what a preset means. Calendar days, inclusive, in the
 * viewer's local time; `all` sends no bounds at all.
 */

export const PRESETS = Object.freeze(['today', '7d', '30d', '90d', 'all', 'custom']);

const DAY_MS = 86400000;

function isoDay(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function defaultRange() {
    return { preset: '30d', from: '', to: '' };
}

/** `{ from, to }` as YYYY-MM-DD strings (or nulls for `all`). */
export function rangeToQuery(range, now = new Date()) {
    const preset = PRESETS.includes(range?.preset) ? range.preset : '30d';
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const back = (days) => ({ from: isoDay(new Date(today.getTime() - (days - 1) * DAY_MS)), to: isoDay(today) });
    switch (preset) {
        case 'today': return back(1);
        case '7d': return back(7);
        case '30d': return back(30);
        case '90d': return back(90);
        case 'all': return { from: null, to: null };
        case 'custom': {
            const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
            return { from: ok(range.from) ? range.from : null, to: ok(range.to) ? range.to : null };
        }
        default: return back(30);
    }
}
