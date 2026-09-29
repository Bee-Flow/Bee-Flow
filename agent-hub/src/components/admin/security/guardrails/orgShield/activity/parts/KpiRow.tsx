/**
 * Four headline figures, each a button that filters the pane on what it
 * counts, each with the per-day shape of that figure beside it.
 *
 * "Stayed in Europe" is the share of PLACED calls that stayed on your server
 * or inside Europe. Calls through a global network and calls with no known
 * place are neither in nor out, so they are left out of the share and named
 * in the line under it instead of being folded into either side.
 */

import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { Totals } from '../shieldTotals';
import { OUTCOME_FILL, REGION_FILL, REGION_ORDER } from '../../shieldPalette';
import { SegmentBar, Sparkline } from './miniCharts';

export interface KpiSeries {
    steppedIn: number[];
    found: number[];
    tool: number[];
}

type Toggle = (axis: 'outcome' | 'pii' | 'region', value: string | boolean) => void;

interface Props {
    totals: Totals;
    series: KpiSeries;
    selectedDay: number | null;
    filters: Record<string, unknown>;
    onToggle: Toggle;
    fmt: (n: number) => string;
    t: TranslateFn;
}

interface CardProps {
    label: string;
    value: React.ReactNode;
    tone?: 'warn';
    active: boolean;
    onClick: () => void;
    chart: React.ReactNode;
    below?: React.ReactNode;
    sub: string;
}

function KpiCard({ label, value, tone, active, onClick, chart, below, sub }: CardProps) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`flex min-w-0 flex-col gap-2 rounded-xl border bg-[var(--bg-card)] px-4 py-3.5 text-left transition-colors hover:bg-[var(--bg-secondary)] ${
                active
                    ? 'border-[var(--text-primary)] shadow-[0_0_0_1px_var(--text-primary)]'
                    : 'border-[var(--border-default)] shadow-[var(--shadow-sm)]'
            }`}
        >
            <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">{label}</span>
            <span className="flex items-end gap-3">
                <span className={`text-[30px] font-bold leading-8 tabular-nums ${tone === 'warn' ? 'text-[var(--warning-ink)]' : 'text-[var(--text-primary)]'}`}>
                    {value}
                </span>
                {chart && <span className="min-w-0 flex-1 pb-[5px]">{chart}</span>}
            </span>
            {below}
            <span className="text-xs text-[var(--text-secondary)]">{sub}</span>
        </button>
    );
}

function euSub(totals: Totals, fmt: Props['fmt'], t: TranslateFn): string {
    const r = totals.regions;
    const parts = [t('shield_activity.kpi_eu_sub', '{own} own server · {eea} EEA · {out} outside', {
        own: fmt(r.local), eea: fmt(r.eu), out: fmt(r.outside),
    })];
    const unplaced = r.via_network + r.unknown;
    if (unplaced > 0) parts.push(t('shield_activity.kpi_eu_unplaced', '{n} not placed', { n: fmt(unplaced) }));
    return parts.join(' · ');
}

function FoundValue({ totals, fmt, t }: Pick<Props, 'totals' | 'fmt' | 't'>) {
    return (
        <>
            {fmt(totals.findings)}
            {totals.findingsFloor && (
                <span className="ml-1 text-[13px] font-semibold text-[var(--text-tertiary)]">{t('shield_activity.kpi_or_more', 'or more')}</span>
            )}
        </>
    );
}

export function KpiRow({ totals, series, selectedDay, filters, onToggle, fmt, t }: Props) {
    const o = totals.outcomes;
    const spark = (values: number[], fill: string) => <Sparkline values={values} fill={fill} selected={selectedDay} />;
    return (
        <div className="grid grid-cols-1 gap-3 @min-[520px]/pane:grid-cols-2 @min-[960px]/pane:grid-cols-4">
            <KpiCard
                label={t('shield_activity.kpi_stepped_in', 'Shield stepped in')}
                value={fmt(o.replaced + o.stopped)}
                active={filters.outcome === 'replaced'}
                onClick={() => onToggle('outcome', 'replaced')}
                chart={spark(series.steppedIn, OUTCOME_FILL.replaced)}
                sub={t('shield_activity.kpi_stepped_in_sub', '{replaced} replaced · {stopped} stopped', { replaced: fmt(o.replaced), stopped: fmt(o.stopped) })}
            />
            <KpiCard
                label={t('shield_activity.kpi_found', 'Personal data found')}
                value={<FoundValue totals={totals} fmt={fmt} t={t} />}
                active={!!filters.pii}
                onClick={() => onToggle('pii', true)}
                chart={spark(series.found, 'var(--text-secondary)')}
                sub={totals.withPersonalData === 1
                    ? t('shield_activity.kpi_found_sub_one', 'in 1 message or call')
                    : t('shield_activity.kpi_found_sub', 'in {n} messages and calls', { n: fmt(totals.withPersonalData) })}
            />
            <KpiCard
                label={t('shield_activity.kpi_tool', 'Left with a tool, unchanged')}
                value={fmt(o.tool)}
                tone="warn"
                active={filters.outcome === 'tool'}
                onClick={() => onToggle('outcome', 'tool')}
                chart={spark(series.tool, OUTCOME_FILL.tool)}
                sub={t('shield_activity.kpi_tool_sub', '{n} of them outside Europe', { n: fmt(totals.toolOutside) })}
            />
            <KpiCard
                label={t('admin.shield_activity_kpi_eu', 'Stayed in Europe')}
                value={totals.stayedPct === null ? '—' : t('shield_activity.pct', '{p}%', { p: totals.stayedPct })}
                active={filters.region === 'outside'}
                onClick={() => onToggle('region', 'outside')}
                chart={null}
                below={(
                    <span className="block overflow-hidden rounded-[3px]">
                        <SegmentBar height={6} gap={4} segments={REGION_ORDER.map(r => ({ key: r, value: totals.regions[r], fill: REGION_FILL[r] }))} />
                    </span>
                )}
                sub={euSub(totals, fmt, t)}
            />
        </div>
    );
}
