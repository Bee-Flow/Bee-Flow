// Single global date-range control, first for the Usage & Monitoring
// dashboard, now shared (website analytics, the Privacy Shield activity tab).
// Replaces the old top-level 7d/30d/90d buttons AND the per-panel
// Today/7d/30d/All/Custom selectors that Feedback & Terminations carried.
// Controlled: owns no state — parent holds `range` and re-fetches on change.
//
// The presets are a segmented control: the chosen one is a raised card in ink
// (like the admin rail's active row), not an accent fill, so it reads the same
// with the grey default accent. Theme tokens only.

import { Calendar } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';

export interface UsageRange {
    preset: string;
    customStart: string;
    customEnd: string;
}

const PRESETS = [
    { id: 'today', key: 'usage.range_today', label: 'Today' },
    { id: '24h', key: 'usage.range_24h', label: '24h' },
    { id: '7d', key: 'usage.range_7d', label: '7d' },
    { id: '30d', key: 'usage.range_30d', label: '30d' },
    { id: '90d', key: 'usage.range_90d', label: '90d' },
    { id: 'all', key: 'usage.range_all', label: 'All' },
    { id: 'custom', key: 'usage.range_custom', label: 'Custom' },
];

// Date → value for an <input type="datetime-local"> (local time, no seconds).
// The same as pages/settings/usage/format.ts toLocalInput, which a shared
// component may not import (components never import from pages).
function localInputValue(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Initial range object. Custom start/end seed the pickers (last 30 days) but are
// only used once the user selects the Custom preset.
export function defaultRange(preset = '30d'): UsageRange {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return { preset, customStart: localInputValue(start), customEnd: localInputValue(end) };
}

const PRESET_BASE = 'inline-flex items-center gap-[5px] rounded-md px-3 py-1.5 text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const PRESET_ON = `${PRESET_BASE} bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm`;
const PRESET_OFF = `${PRESET_BASE} bg-transparent text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]`;
const GROUP = 'flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-0.5';
const DATE_INPUT = 'rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-1.5 py-[3px] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--text-secondary)]';

export default function RangeControl({ range, onChange, t, presets }: {
    range: UsageRange;
    onChange: (next: UsageRange) => void;
    t?: TranslateFn;
    presets?: string[];
}) {
    const tr = (k: string, fb: string) => (t ? t(k, fb) : fb);
    const setPreset = (preset: string) => onChange({ ...range, preset });
    const setCustom = (patch: Partial<UsageRange>) => onChange({ ...range, ...patch, preset: 'custom' });
    // Optional subset (array of preset ids) for compact hosts — the Privacy
    // Shield Activity tab shows 7d/30d/90d only. Default: all presets.
    const shown = Array.isArray(presets) ? PRESETS.filter(p => presets.includes(p.id)) : PRESETS;

    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                {tr('usage.range', 'Range')}
            </span>
            <div className={GROUP}>
                {shown.map(p => {
                    const active = range.preset === p.id;
                    return (
                        <button key={p.id} type="button" aria-pressed={active} onClick={() => setPreset(p.id)} className={active ? PRESET_ON : PRESET_OFF}>
                            {p.id === 'custom' && <Calendar className="h-[11px] w-[11px]" aria-hidden="true" />}
                            {tr(p.key, p.label)}
                        </button>
                    );
                })}
            </div>
            {range.preset === 'custom' && (
                <div className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-1">
                    <input type="datetime-local" aria-label={tr('admin_ui.range_from', 'From')} value={range.customStart} max={range.customEnd} onChange={e => setCustom({ customStart: e.target.value })} className={DATE_INPUT} />
                    <span className="text-[11px] text-[var(--text-tertiary)]" aria-hidden="true">→</span>
                    <input type="datetime-local" aria-label={tr('admin_ui.range_to', 'To')} value={range.customEnd} min={range.customStart} onChange={e => setCustom({ customEnd: e.target.value })} className={DATE_INPUT} />
                </div>
            )}
        </div>
    );
}
