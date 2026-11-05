import { Activity, BarChart3, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import StackedColumnChart from '@/components/shared/charts/StackedColumnChart';
import { useTranslation } from '@/hooks/useTranslation';
import { Card, EmptyInline, SectionTitle } from '../kit';
import type { AdoptionArea, AdoptionAreaSource, AdoptionAreas } from './adoption.types';
import { AREA_ORDER, SERIES_AREAS, areaMeta, seriesAreaOf } from './areaMeta';
import { fInt, fMoney, sharePct } from './format';

type T = ReturnType<typeof useTranslation>['t'];

/** One row of the area list: a series area, or "Other" with the areas folded into it. */
export interface AreaRow {
    id: string;
    cost: number;
    calls: number | null;
    /** For "Other" the largest of its areas: people cannot be summed across areas. */
    people: number;
    folded: string[];
    sources: AdoptionAreaSource[];
}

const LIST_ID = 'adoption-areas-table';

/**
 * The areas as the report draws them: every series area with spend, then
 * "Other" holding every area without a slot (and the raw "other" sources),
 * so the list, the chart and the CSV add up to the same total.
 */
export function foldAreas(areas: AdoptionArea[]): AreaRow[] {
    const rows = new Map<string, AreaRow>();
    const ordered = [...areas].sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
    for (const a of ordered) {
        const id = seriesAreaOf(a.area);
        const row = rows.get(id) || { id, cost: 0, calls: null, people: 0, folded: [], sources: [] };
        row.cost += Number(a.cost) || 0;
        if (a.calls != null) row.calls = (row.calls ?? 0) + Number(a.calls);
        row.people = Math.max(row.people, Number(a.people) || 0);
        if (id !== a.area && (Number(a.cost) > 0 || (a.calls ?? 0) > 0)) row.folded.push(a.area);
        row.sources.push(...(Array.isArray(a.sources) ? a.sources : []));
        rows.set(id, row);
    }
    const list = [...rows.values()].filter(r => r.cost > 0 || (r.calls ?? 0) > 0);
    const other = list.filter(r => r.id === 'other');
    return [...list.filter(r => r.id !== 'other').sort((a, b) => b.cost - a.cost), ...other];
}

function rowSub(row: AreaRow, showCalls: boolean, t: T): string {
    if (row.id === 'other' && row.folded.length) return row.folded.map(id => areaMeta(id, t).label).join(', ');
    const parts = [t('adoption.areas_people', '{n} people', { n: fInt(row.people) })];
    if (showCalls && row.calls != null) parts.push(t('adoption.areas_calls', '{n} calls', { n: fInt(row.calls) }));
    return parts.join(' · ');
}

interface AreaListRowProps { row: AreaRow; total: number; max: number; currency: string; showCalls: boolean }

function AreaListRow({ row, total, max, currency, showCalls }: AreaListRowProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const meta = areaMeta(row.id, t);
    const Icon = meta.icon;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <li className="border-b border-[var(--border-subtle)] last:border-b-0">
            <button
                type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="grid w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[var(--bg-tertiary)] [grid-template-columns:auto_minmax(0,14rem)_1fr_auto_auto]"
            >
                <Chevron className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden="true" />
                <span className="flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                    <span className="min-w-0">
                        <span className="block truncate text-[12px] font-semibold text-[var(--text-primary)]">{meta.label}</span>
                        <span className="block truncate text-[10px] text-[var(--text-muted)]">{rowSub(row, showCalls, t)}</span>
                    </span>
                </span>
                <span className="h-2.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]" aria-hidden="true">
                    <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (row.cost / (max || 1)) * 100)}%`, background: meta.color }} />
                </span>
                <span className="text-[12px] font-bold tabular-nums text-[var(--text-primary)]">{fMoney(row.cost, currency)}</span>
                <span className="w-10 text-right text-[11px] tabular-nums text-[var(--text-muted)]">{`${sharePct(row.cost, total)}%`}</span>
            </button>
            {open && <SourceList sources={row.sources} currency={currency} showCalls={showCalls} />}
        </li>
    );
}

function SourceList({ sources, currency, showCalls }: { sources: AdoptionAreaSource[]; currency: string; showCalls: boolean }) {
    const { t } = useTranslation();
    const list = [...sources].sort((a, b) => b.cost - a.cost);
    if (list.length === 0) return <p className="px-10 pb-2.5 text-[11px] text-[var(--text-muted)]">{t('adoption.areas_no_sources', 'No ledger rows in this period.')}</p>;
    return (
        <ul className="px-10 pb-2.5" aria-label={t('adoption.areas_sources_label', 'Ledger sources')}>
            {list.map(s => (
                <li key={s.source} className="flex justify-between gap-3 py-0.5 text-[11px] text-[var(--text-secondary)]">
                    <code className="truncate text-[10px]">{s.source}</code>
                    <span className="tabular-nums">
                        {showCalls && s.calls != null ? `${fInt(s.calls)} · ` : ''}{fMoney(s.cost, currency)}
                    </span>
                </li>
            ))}
        </ul>
    );
}

interface AreasProps { data: AdoptionAreas; currency: string; showCalls: boolean }

/** The bar list of spend per area: also the table view of the weekly chart. */
function AreaList({ data, currency, showCalls }: AreasProps) {
    const { t } = useTranslation();
    const rows = foldAreas(data.areas || []);
    const total = rows.reduce((s, r) => s + r.cost, 0);
    const calls = rows.reduce<number | null>((s, r) => (r.calls == null ? s : (s ?? 0) + r.calls), null);
    const max = rows.reduce((m, r) => Math.max(m, r.cost), 0);
    const right = showCalls && calls != null
        ? t('adoption.areas_share_calls', 'share of {cost} · {n} calls', { cost: fMoney(total, currency), n: fInt(calls) })
        : t('adoption.areas_share', 'share of {cost}', { cost: fMoney(total, currency) });
    return (
        <div>
            <SectionTitle icon={Activity} right={<span className="text-[11px] text-[var(--text-muted)]">{right}</span>}>
                {t('adoption.areas_title', 'Where the AI goes')}
            </SectionTitle>
            <Card>
                {rows.length === 0
                    ? <EmptyInline text={t('adoption.areas_empty', 'No AI usage recorded in this period.')} />
                    : (
                        <ul id={LIST_ID} aria-label={t('adoption.areas_list_label', 'AI spend per area')}>
                            {rows.map(r => <AreaListRow key={r.id} row={r} total={total} max={max} currency={currency} showCalls={showCalls} />)}
                        </ul>
                    )}
            </Card>
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                {t('adoption.areas_expand_hint', 'Open an area to see the ledger sources behind it.')}{' '}
                <a href="#adoption-notes" className="underline underline-offset-2">{t('adoption.areas_unmetered', 'Some surfaces are not metered yet: see the note below.')}</a>
            </p>
        </div>
    );
}

/** "W 41" from "2026-W41". */
function weekLabel(week: string, complete: boolean, t: T): string {
    const n = String(week).split('-W')[1] || week;
    const base = t('adoption.areas_week', 'W {n}', { n: Number(n) || n });
    return complete ? base : t('adoption.areas_week_partial', '{week} · partial', { week: base });
}

/** The weekly stacked columns, one series per area slot plus a neutral "Other". */
function WeeklyChart({ data, currency }: AreasProps) {
    const { t } = useTranslation();
    const weeks = data.timeline?.weeks || [];
    const used = new Set(foldAreas(data.areas || []).map(r => r.id));
    const series = [...SERIES_AREAS, 'other'].filter(id => used.has(id)).map((id) => {
        const m = areaMeta(id, t);
        return { key: id, label: m.label, color: m.color };
    });
    const cols = weeks.map((w) => {
        const values: Record<string, number> = {};
        for (const [area, v] of Object.entries(w.byArea || {})) {
            const key = seriesAreaOf(area);
            values[key] = (values[key] || 0) + (Number(v) || 0);
        }
        return { x: w.week, label: weekLabel(w.week, w.complete, t), values, faded: !w.complete };
    });
    return (
        <Card title={t('adoption.areas_weekly_title', 'AI spend per week, by area')} icon={BarChart3}
            right={<a href={`#${LIST_ID}`} className="text-[11px] text-[var(--text-secondary)] underline underline-offset-2">{t('adoption.areas_table_view', 'Table view')}</a>}>
            <p className="-mt-1.5 mb-2 text-[11px] text-[var(--text-muted)]">{t('adoption.areas_weekly_sub', 'Completed ISO weeks · the current week is shown faded')}</p>
            {cols.length === 0
                ? <EmptyInline text={t('adoption.areas_empty', 'No AI usage recorded in this period.')} />
                : <StackedColumnChart data={cols} series={series} ariaLabel={t('adoption.areas_weekly_title', 'AI spend per week, by area')} valueFormatter={(n) => fMoney(n, currency)} />}
        </Card>
    );
}

/** "Where the AI goes": the area list (the table view) and the weekly chart beside it. */
export default function AreasSection(props: AreasProps) {
    return (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
            <AreaList {...props} />
            <WeeklyChart {...props} />
        </div>
    );
}
