/**
 * A ranked list with a share bar per row: kinds of data, where it started,
 * people. Every row is a filter toggle.
 *
 * The list counts over every filter EXCEPT its own axis, so picking a person
 * keeps the other people listed (the pick highlighted) instead of shrinking
 * the list to one row.
 *
 * `note` says what the counts cover when that is less than the window (the
 * latest rows of a capped fetch), under the list where it qualifies it.
 *
 * A row marked `totalOnly` (a health category, GDPR Art. 9) is a readout and
 * not a toggle: the same row without the button, and `totalOnlyNote` under
 * the list says why.
 */

import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { RankBar } from './miniCharts';
import { Panel, PanelHead } from './Panel';

export interface RankItem {
    value: string;
    label: string;
    count: number;
    /** An organisation total that cannot be picked as a filter. */
    totalOnly?: boolean;
}

interface Props {
    icon: LucideIcon;
    title: string;
    hint?: string;
    items: RankItem[];
    active: string | null;
    onPick: (value: string) => void;
    /** The row's accessible name ("Filter on Kim"). */
    pickLabel: (item: RankItem) => string;
    empty: string;
    note?: string;
    /** Why some rows cannot be picked; shown whenever given, even when those rows are not listed. */
    totalOnlyNote?: string;
    fmt: (n: number) => string;
}

const ROW = '-mx-2 flex flex-col gap-[5px] rounded-lg px-2 py-1.5 text-left text-xs text-[var(--text-primary)]';

function RowBody({ item, on, top, fmt }: { item: RankItem; on: boolean; top: number; fmt: (n: number) => string }) {
    return (
        <>
            <span className="flex w-full justify-between gap-2">
                <span className="min-w-0 truncate">{item.label}</span>
                <b className="tabular-nums">{fmt(item.count)}</b>
            </span>
            <RankBar share={item.count / top} active={on} />
        </>
    );
}

export function RankCard({ icon, title, hint, items, active, onPick, pickLabel, empty, note, totalOnlyNote, fmt }: Props) {
    const top = Math.max(1, ...items.map(i => i.count));
    return (
        <Panel className="flex flex-col gap-1 px-4 py-3.5" label={title}>
            <PanelHead icon={icon} title={title} hint={hint} className="pb-1.5" />
            {items.length === 0 && <p className="m-0 py-1 text-[11px] text-[var(--text-tertiary)]">{empty}</p>}
            {items.map(item => {
                if (item.totalOnly) {
                    return (
                        <div key={item.value} className={ROW}>
                            <RowBody item={item} on={false} top={top} fmt={fmt} />
                        </div>
                    );
                }
                const on = active === item.value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        aria-pressed={on}
                        aria-label={pickLabel(item)}
                        onClick={() => onPick(item.value)}
                        className={`${ROW} ${
                            on ? 'bg-[color-mix(in_srgb,var(--info-ink)_8%,transparent)]' : 'hover:bg-[var(--bg-secondary)]'
                        }`}
                    >
                        <RowBody item={item} on={on} top={top} fmt={fmt} />
                    </button>
                );
            })}
            {note && items.length > 0 && <p className="m-0 pt-1 text-[11px] text-[var(--text-tertiary)]">{note}</p>}
            {totalOnlyNote && <p className="m-0 pt-1 text-[11px] text-[var(--text-tertiary)]">{totalOnlyNote}</p>}
        </Panel>
    );
}
