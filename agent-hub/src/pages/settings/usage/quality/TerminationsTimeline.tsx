import { useTranslation } from '@/hooks/useTranslation';
import { TYPE_ORDER } from '@/utils/terminationsModel';
import type { TimelinePoint } from '@/pages/settings/OrgTerminationsPanel.types';
import { EmptyInline } from '../kit';
import { paint, Swatch } from '../shell';
import { typeMeta } from './terminationMeta';

type Bucket = { period: string; counts: Record<string, number>; total: number };

function bucketsOf(data: TimelinePoint[]): Bucket[] {
    const byPeriod = new Map<string, Bucket>();
    for (const r of data) {
        const b = byPeriod.get(r.period) ?? { period: r.period, counts: {}, total: 0 };
        b.counts[r.termination_type] = (b.counts[r.termination_type] || 0) + r.count;
        b.total += r.count;
        byPeriod.set(r.period, b);
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export function TerminationsTimeline({ data }: { data: TimelinePoint[] }) {
    const { t } = useTranslation();
    const buckets = bucketsOf(data);
    const max = Math.max(...buckets.map(b => b.total), 1);
    return (
        <section aria-label={t('org.terminations_over_time', 'Terminations over time')} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
            <h3 className="m-0 mb-2 text-[15px] font-semibold text-[var(--text-primary)]">{t('org.terminations_over_time', 'Terminations over time')}</h3>
            <ul className="m-0 mb-1.5 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11px] text-[var(--text-muted)]">
                {TYPE_ORDER.map(tk => (
                    <li key={tk} className="flex items-center gap-1">
                        <Swatch color={typeMeta(tk).color} />
                        {t(`org.terminations_type_${tk}`, tk)}
                    </li>
                ))}
            </ul>
            {buckets.length === 0 ? <EmptyInline boxed text={t('org.terminations_no_data', 'No data to display')} /> : (
                <div className="flex h-[140px] items-end gap-1 py-2">
                    {buckets.map(b => (
                        <div key={b.period} className="flex h-full min-w-[8px] flex-1 flex-col items-center justify-end gap-1">
                            <div
                                title={`${b.period} · ${b.total}`}
                                className="flex w-full flex-col justify-end overflow-hidden rounded-t"
                                ref={el => paint(el, { height: `${(b.total / max) * 100}%`, 'min-height': b.total > 0 ? '2px' : '0px' })}
                            >
                                {TYPE_ORDER.filter(tk => b.counts[tk]).map(tk => (
                                    <div key={tk} ref={el => paint(el, { height: `${(b.counts[tk] / b.total) * 100}%`, 'background-color': typeMeta(tk).color })} />
                                ))}
                            </div>
                            <span className="whitespace-nowrap text-[9px] text-[var(--text-muted)]">{b.period.slice(5)}</span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
