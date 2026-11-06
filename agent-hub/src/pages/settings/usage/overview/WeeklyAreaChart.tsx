// "AI spend per week, by area": the weekly stacked columns of the Adoption
// report's area view, on the Overview. Built from the same `timeline.weeks`
// shape and the same area folding, so both charts always agree.

import StackedColumnChart from '@/components/shared/charts/StackedColumnChart';
import { useTranslation } from '@/hooks/useTranslation';
import { MoreLink, Swatch } from '../shell';
import type { AdoptionAreas } from '../adoption/adoption.types';
import { SERIES_AREAS, areaMeta, seriesAreaOf } from '../adoption/areaMeta';
import { foldAreas } from '../adoption/AreasSection';
import { fMoney } from '../adoption/format';

interface WeeklyAreaChartProps {
    areas: AdoptionAreas;
    currency: string;
    onTableView: () => void;
}

type T = ReturnType<typeof useTranslation>['t'];

/** "W 41" from "2026-W41"; a week still running is marked partial. */
function weekLabel(week: string, complete: boolean, t: T): string {
    const n = String(week).split('-W')[1] || week;
    const base = t('adoption.areas_week', 'W {n}', { n: Number(n) || n });
    return complete ? base : t('adoption.areas_week_partial', '{week} · partial', { week: base });
}

export function WeeklyAreaChart({ areas, currency, onTableView }: WeeklyAreaChartProps) {
    const { t } = useTranslation();
    const title = t('adoption.areas_weekly_title', 'AI spend per week, by area');
    const weeks = areas.timeline?.weeks || [];
    const used = new Set(foldAreas(areas.areas || []).map(r => r.id));
    const series = [...SERIES_AREAS, 'other'].filter(id => used.has(id)).map((id) => {
        const m = areaMeta(id, t);
        return { key: id, label: m.label, color: m.color };
    });
    const cols = weeks.map((w) => {
        const values: Record<string, number> = {};
        for (const [area, v] of Object.entries(w.byArea || {})) {
            const slot = seriesAreaOf(area);
            values[slot] = (values[slot] || 0) + (Number(v) || 0);
        }
        return { x: w.week, label: weekLabel(w.week, w.complete, t), values, faded: !w.complete };
    });
    if (cols.length === 0) return null;
    return (
        <section aria-label={title} className="flex flex-col gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 pb-3 pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <div className="flex flex-col gap-0.5">
                    <h3 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{title}</h3>
                    <p className="m-0 text-xs text-[var(--text-muted)]">{t('usage.ov_weekly_sub', 'Completed ISO weeks; the current week is shown lighter')}</p>
                </div>
                <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-[var(--text-secondary)]">
                    {series.map(item => (
                        <li key={item.key} className="inline-flex items-center gap-1.5">
                            <Swatch color={item.color} className="h-2 w-2 rounded-sm" />
                            {item.label}
                        </li>
                    ))}
                </ul>
            </div>
            <StackedColumnChart data={cols} series={series} ariaLabel={title} valueFormatter={(n) => fMoney(n, currency)} />
            <div className="flex justify-end">
                <MoreLink label={t('usage.ov_table_view', 'Table view')} onClick={onTableView} />
            </div>
        </section>
    );
}
