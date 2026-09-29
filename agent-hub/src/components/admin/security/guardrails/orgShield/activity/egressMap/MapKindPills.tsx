/**
 * The kind filter, where the map is: "All data", the four kinds found most,
 * the one that is on if it is not among them, and the rest in a "+N more"
 * menu. The same `kind` filter the rest of the pane uses; this is only
 * another place to set it.
 *
 * One row, as wide as its pills: on a narrow card it scrolls sideways
 * rather than wrapping over the map, and it never covers more of the map
 * than the pills themselves.
 */

import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { fNum } from '../../../../../../../pages/settings/usage/format';
import type { EgressMapFilters, KindCount } from './egressMapContract';

const TOP = 4;

const PILL = 'shrink-0 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-4 whitespace-nowrap';
const OFF = 'border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-card)_95%,transparent)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]';
const ON = 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)]';

function Pill({ on, label, n, onClick }: { on: boolean; label: string; n?: number; onClick: () => void }) {
    return (
        <button type="button" aria-pressed={on} onClick={onClick} className={`${PILL} ${on ? ON : OFF}`}>
            {label}
            {n !== undefined && (
                <b className={`font-semibold tabular-nums ${on ? 'text-[color-mix(in_srgb,rgb(from_var(--bg-card)_r_g_b_/_1)_70%,var(--text-primary))]' : 'text-[var(--text-tertiary)]'}`}>
                    {fNum(n)}
                </b>
            )}
        </button>
    );
}

/** Which kinds get a pill, and which go in the menu. Exported for its test. */
export function splitKinds(kinds: KindCount[], selected: string | null, catLabel: (id: string) => string) {
    const pills = kinds.slice(0, TOP);
    if (selected && !pills.some(k => k.id === selected)) {
        pills.push(kinds.find(k => k.id === selected) || { id: selected, label: catLabel(selected), n: 0 });
    }
    const more = kinds.slice(TOP).filter(k => k.id !== selected);
    return { pills, more };
}

export function MapKindPills({ filters, t }: { filters: EgressMapFilters; t: TranslateFn }) {
    const { kindCounts, selectedKind, onSelectKind, catLabel } = filters;
    if (!kindCounts.length && !selectedKind) return null;
    const { pills, more } = splitKinds(kindCounts, selectedKind, catLabel);
    return (
        <div
            role="group"
            aria-label={t('egress_map.kinds_label', 'Kinds of data')}
            className="absolute left-2.5 top-2.5 z-10 flex gap-[5px] max-w-[calc(100%-62px)] overflow-x-auto [scrollbar-width:none]"
        >
            <Pill on={!selectedKind} label={t('egress_map.kind_all', 'All data')} onClick={() => onSelectKind(null)} />
            {pills.map(k => (
                <Pill key={k.id} on={selectedKind === k.id} label={k.label} n={k.n} onClick={() => onSelectKind(k.id)} />
            ))}
            {more.length > 0 && (
                <select
                    value=""
                    onChange={(e) => { if (e.target.value) onSelectKind(e.target.value); }}
                    aria-label={t('egress_map.kind_more_label', 'More kinds of data')}
                    className={`${PILL} ${OFF} appearance-none field-sizing-content cursor-pointer`}
                >
                    <option value="">{t('egress_map.kind_more', '+{n} more', { n: more.length })}</option>
                    {more.map(k => (
                        <option key={k.id} value={k.id}>
                            {t('egress_map.kind_option', '{kind} ({n})', { kind: k.label, n: fNum(k.n) })}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}
