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
 */

import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { RankBar } from './miniCharts';
import { Panel, PanelHead } from './Panel';

export interface RankItem {
    value: string;
    label: string;
    count: number;
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
    fmt: (n: number) => string;
}

export function RankCard({ icon, title, hint, items, active, onPick, pickLabel, empty, note, fmt }: Props) {
    const top = Math.max(1, ...items.map(i => i.count));
    return (
        <Panel className="flex flex-col gap-1 px-4 py-3.5" label={title}>
            <PanelHead icon={icon} title={title} hint={hint} className="pb-1.5" />
            {items.length === 0 && <p className="m-0 py-1 text-[11px] text-[var(--text-tertiary)]">{empty}</p>}
            {items.map(item => {
                const on = active === item.value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        aria-pressed={on}
                        aria-label={pickLabel(item)}
                        onClick={() => onPick(item.value)}
                        className={`-mx-2 flex flex-col gap-[5px] rounded-lg px-2 py-1.5 text-left text-xs text-[var(--text-primary)] ${
                            on ? 'bg-[color-mix(in_srgb,var(--info-ink)_8%,transparent)]' : 'hover:bg-[var(--bg-secondary)]'
                        }`}
                    >
                        <span className="flex w-full justify-between gap-2">
                            <span className="min-w-0 truncate">{item.label}</span>
                            <b className="tabular-nums">{fmt(item.count)}</b>
                        </span>
                        <RankBar share={item.count / top} active={on} />
                    </button>
                );
            })}
            {note && items.length > 0 && <p className="m-0 pt-1 text-[11px] text-[var(--text-tertiary)]">{note}</p>}
        </Panel>
    );
}
