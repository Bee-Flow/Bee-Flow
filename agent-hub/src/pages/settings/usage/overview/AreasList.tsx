// "Where the AI goes": the areas with spend, biggest first, each with a share
// bar. The list ends with a link to the full view in Adoption.

import { useTranslation } from '@/hooks/useTranslation';
import { MoreLink, Swatch } from '../shell';
import type { AdoptionAreas } from '../adoption/adoption.types';
import { areaMeta } from '../adoption/areaMeta';
import { foldAreas, type AreaRow } from '../adoption/AreasSection';
import { fInt, fMoney, sharePct } from '../adoption/format';
import { ShareBar } from '../spend/ShareBar';

interface AreasListProps {
    areas: AdoptionAreas;
    currency: string;
    showCalls: boolean;
    onOpenAdoption: () => void;
}

type T = ReturnType<typeof useTranslation>['t'];

function rowSub(row: AreaRow, showCalls: boolean, t: T): string {
    if (row.id === 'other' && row.folded.length) return row.folded.map(id => areaMeta(id, t).label).join(', ');
    const parts = [t('adoption.areas_people', '{n} people', { n: fInt(row.people) })];
    if (showCalls && row.calls != null) parts.push(t('adoption.areas_calls', '{n} calls', { n: fInt(row.calls) }));
    return parts.join(' · ');
}

export function AreasList({ areas, currency, showCalls, onOpenAdoption }: AreasListProps) {
    const { t } = useTranslation();
    const rows = foldAreas(areas.areas || []);
    const total = rows.reduce((s, r) => s + r.cost, 0);
    const calls = rows.reduce<number | null>((s, r) => (r.calls == null ? s : (s ?? 0) + r.calls), null);
    const max = rows.reduce((m, r) => Math.max(m, r.cost), 0);
    const caption = showCalls && calls != null
        ? t('adoption.areas_share_calls', 'share of {cost} · {n} calls', { cost: fMoney(total, currency), n: fInt(calls) })
        : t('adoption.areas_share', 'share of {cost}', { cost: fMoney(total, currency) });
    return (
        <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 pb-2 pt-5">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('adoption.areas_title', 'Where the AI goes')}</h3>
                <span className="text-xs text-[var(--text-muted)]">{caption}</span>
            </div>
            {rows.length === 0 ? (
                <p className="m-0 py-3 text-[13px] text-[var(--text-muted)]">{t('adoption.areas_empty', 'No AI usage recorded in this period.')}</p>
            ) : (
                <ul className="m-0 flex list-none flex-col p-0" aria-label={t('adoption.areas_list_label', 'AI spend per area')}>
                    {rows.map((r) => {
                        const meta = areaMeta(r.id, t);
                        return (
                            <li key={r.id} className="flex items-center gap-3 border-t border-[var(--border-subtle)] py-2.5 first:border-t-0">
                                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                    <span className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                                        <Swatch color={meta.color} className="h-2.5 w-2.5 rounded-sm" />
                                        {meta.label}
                                        <span className="truncate text-xs font-normal text-[var(--text-muted)]">{rowSub(r, showCalls, t)}</span>
                                    </span>
                                    <ShareBar parts={[{ pct: max > 0 ? Math.max(2, (r.cost / max) * 100) : 0, color: meta.color }]} maxWidth={320} />
                                </div>
                                <span className="text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">{fMoney(r.cost, currency)}</span>
                                <span className="w-10 text-right text-xs tabular-nums text-[var(--text-muted)]">{`${sharePct(r.cost, total)}%`}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
            <MoreLink label={t('usage.ov_all_areas', 'All areas in Adoption')} onClick={onOpenAdoption} />
        </article>
    );
}
