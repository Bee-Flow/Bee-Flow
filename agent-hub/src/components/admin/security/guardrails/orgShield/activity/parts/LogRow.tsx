/**
 * One entry in the log: when, who, where it started, what was found, what
 * happened, and where it went — and, opened, every fact the ledger kept.
 *
 * "What happened" keeps the stored action's own words for a shield event
 * ("Placeholders", "Hidden", "Sent anyway"), with the outcome's colour as
 * the dot, so the finer distinction is not lost to the five-way grouping.
 */

import { ChevronDown } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { ENTRY_WORDS, OUTCOME_SHORT_WORDS, REGION_WORDS, actionLabel, wordFor } from '../activityLabels';
import { shortLocation } from '../egressMap/locationCopy';
import type { MapDestination } from '../egressMap/mapModel';
import type { StreamRow } from '../shieldStream';
import { REGION_TEXT } from '../../shieldPalette';
import { detailPairs } from './logDetails';
import { outcomeDot } from './outcomeDot';

/** The log's columns; the header row uses the same template. */
/**
 * The log's columns. On a pane narrower than 1100px (a laptop beside the
 * settings nav) "Started in" folds under the person's name instead of taking
 * a column, so "What we found" keeps room for its chips.
 */
export const LOG_GRID = 'grid gap-3 grid-cols-[48px_minmax(0,160px)_minmax(0,1fr)_150px_170px_16px] @min-[1100px]/pane:grid-cols-[52px_150px_170px_minmax(0,1fr)_170px_190px_16px]';

/** A cell that only has its own column on a wide pane. */
export const WIDE_ONLY = '@max-[1099px]/pane:hidden';

export function initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

interface Props {
    row: StreamRow;
    open: boolean;
    onToggle: () => void;
    onPickKind: (kind: string) => void;
    catLabel: (id: string) => string;
    locale: string;
    t: TranslateFn;
}

function happened(row: StreamRow, t: TranslateFn): string {
    if (row.source === 'guard') return actionLabel(row.action, t);
    if (row.action === 'blocked') return t('admin.shield_activity_status_blocked', 'Stopped by the shield');
    return wordFor(OUTCOME_SHORT_WORDS, row.outcome, t);
}

function WentTo({ row, t }: { row: StreamRow; t: TranslateFn }) {
    if (row.source === 'egress') {
        return (
            <span className="min-w-0">
                <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">{row.dest || '—'}</span>
                <span className={`block truncate text-[11px] ${row.region ? REGION_TEXT[row.region] : ''}`} title={row.region ? wordFor(REGION_WORDS, row.region, t) : undefined}>
                    {shortLocation(row as unknown as MapDestination, t)}
                </span>
            </span>
        );
    }
    return (
        <span className="min-w-0">
            <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">{row.model || '—'}</span>
            <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{wordFor(ENTRY_WORDS, row.entry, t)}</span>
        </span>
    );
}

function Found({ row, onPickKind, catLabel, t }: Pick<Props, 'row' | 'onPickKind' | 'catLabel' | 't'>) {
    if (row.kinds.length === 0) return <span className="text-[11px] text-[var(--text-tertiary)]">{t('shield_activity.nothing', 'nothing')}</span>;
    return (
        <>
            {row.kinds.map(k => (
                <button
                    key={k}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPickKind(k); }}
                    title={catLabel(k)}
                    className="max-w-full truncate rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-primary)] hover:border-[var(--border-default)]"
                >
                    {catLabel(k)}
                </button>
            ))}
        </>
    );
}

function Detail({ row, locale, t }: Pick<Props, 'row' | 'locale' | 't'>) {
    return (
        <div className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-[18px] pb-4 pt-1 @min-[640px]/pane:pl-[82px]">
            <dl className="m-0 grid grid-cols-1 gap-x-8 gap-y-1.5 text-xs @min-[700px]/pane:grid-cols-2 @min-[1100px]/pane:grid-cols-3">
                {detailPairs(row, t, locale).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2.5 border-b border-[var(--border-subtle)] pb-[5px]">
                        <dt className="text-[var(--text-tertiary)]">{k}</dt>
                        <dd className="m-0 min-w-0 break-words text-right font-medium text-[var(--text-primary)]">{v || '—'}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

export function LogRow({ row, open, onToggle, onPickKind, catLabel, locale, t }: Props) {
    return (
        <li>
            <div
                onClick={onToggle}
                className={`${LOG_GRID} cursor-pointer items-center border-b border-[var(--border-subtle)] px-[18px] py-2 text-xs ${open ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)]'}`}
            >
                <span className="tabular-nums text-[var(--text-tertiary)]">{row.time}</span>
                <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--bg-tertiary)] text-[9px] font-bold text-[var(--text-primary)]">
                        {initials(row.personLabel)}
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-[var(--text-primary)]">{row.personLabel || '—'}</span>
                        <span className="block truncate text-[11px] text-[var(--text-secondary)] @min-[1100px]/pane:hidden">{row.place}</span>
                    </span>
                </span>
                <span className={`truncate text-[var(--text-secondary)] ${WIDE_ONLY}`}>{row.place}</span>
                <span className="flex min-w-0 flex-wrap gap-[5px]"><Found row={row} onPickKind={onPickKind} catLabel={catLabel} t={t} /></span>
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-[var(--text-primary)]">
                    <span aria-hidden="true" className={outcomeDot(row.outcome)} />
                    <span className="truncate">{happened(row, t)}</span>
                </span>
                <WentTo row={row} t={t} />
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onToggle(); }}
                    aria-expanded={open}
                    aria-label={t('admin.shield_activity_row_expand', 'Show the evidence for this row')}
                    className="grid place-items-center text-[var(--text-tertiary)]"
                >
                    <ChevronDown className={`h-[13px] w-[13px] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
            </div>
            {open && <Detail row={row} locale={locale} t={t} />}
        </li>
    );
}
