/**
 * The filter bar: one removable chip per active axis, "Clear all", and how
 * many of the loaded messages and calls are left.
 *
 * Under it, only while a filter is on AND a fetch hit its ceiling, the
 * sample notice. Once filtered, every figure is counted over the rows we
 * hold, and for a busy organisation that is not the whole window: presenting
 * such a count as a total is the bug the server-side aggregates exist to
 * prevent, so the notice is not optional.
 */

import { Info, ListFilter, X } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';

export interface Chip {
    key: string;
    /** Dim prefix naming the axis ("Kind", "Started in"); empty for a self-explaining chip. */
    axis: string;
    label: string;
}

interface Props {
    chips: Chip[];
    onRemove: (key: string) => void;
    onClear: () => void;
    shown: number;
    total: number;
    capped: boolean;
    t: TranslateFn;
}

export function FilterBar({ chips, onRemove, onClear, shown, total, capped, t }: Props) {
    return (
        <div className="flex min-h-[38px] flex-wrap items-center gap-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-1.5">
            <ListFilter className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            {chips.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                    {chips.map(chip => (
                        <button
                            key={chip.key}
                            type="button"
                            onClick={() => onRemove(chip.key)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--text-primary)] py-1 pl-2.5 pr-1.5 text-[11px] font-semibold text-[rgb(from_var(--bg-card)_r_g_b_/_1)] hover:opacity-85"
                        >
                            {chip.axis && <span className="font-medium opacity-60">{chip.axis}</span>}
                            {chip.label}
                            <X className="h-[11px] w-[11px]" aria-hidden="true" />
                            <span className="sr-only">{t('admin.shield_activity_chip_remove', 'Remove this filter')}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={onClear}
                        className="whitespace-nowrap text-[11px] font-semibold text-[var(--text-secondary)] underline"
                    >
                        {t('admin.shield_activity_clear_all', 'Clear all')}
                    </button>
                </div>
            ) : (
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('shield_activity.no_filter', 'Showing everything. Click anything below to narrow it down — filters stack.')}
                </span>
            )}
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-[var(--text-secondary)]">
                {capped
                    ? t('shield_activity.count_capped', '{n} of the latest {total} messages & calls', { n: shown, total })
                    : t('shield_activity.count', '{n} of {total} messages & calls', { n: shown, total })}
            </span>
        </div>
    );
}

export function SampleNotice({ limit, t }: { limit: number; t: TranslateFn }) {
    return (
        <p
            role="status"
            className="m-0 flex items-start gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--info)_9%,transparent)] px-3 py-2 text-[11px] leading-4 text-[var(--info-ink)]"
        >
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
                {t('admin.shield_activity_sampled',
                    'While a filter is on, the figures are counted over the most recent {n} rows rather than the whole period — so treat them as "at least".',
                    { n: limit })}
            </span>
        </p>
    );
}
