import { Empty } from './shared';
import { TYPE_ORDER } from '@/utils/terminationsModel';
import { useTranslation } from '@/hooks/useTranslation';
import type { TimelineRow, Bucket } from './TerminationsPage.types';
import { TYPE_META } from './TerminationsPage.helpers';

/** Terminations per period, stacked by type; the heights are the data, the colours the type's series slot. */
export function StackedBarChart({ data }: { data: TimelineRow[] }) {
    const { t } = useTranslation();
    if (!data || data.length === 0) return <Empty text={t('admin_monitoring.term_no_data', 'No data to display')} />;

    // data: [{ period, type, count }, ...]; aggregate by period
    const buckets: Record<string, Bucket> = {};
    for (const r of data) {
        if (!buckets[r.period]) buckets[r.period] = { period: r.period };
        buckets[r.period][r.type] = Number(buckets[r.period][r.type] || 0) + r.count;
    }
    const periods = Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period));
    const maxTotal = Math.max(...periods.map(p => TYPE_ORDER.reduce((s, ty) => s + Number(p[ty] || 0), 0)), 1);
    return (
        <div className="flex h-[140px] items-end gap-1 py-2">
            {periods.map(p => {
                const total = TYPE_ORDER.reduce((s, ty) => s + Number(p[ty] || 0), 0);
                return (
                    <div key={p.period} className="flex h-full min-w-[8px] flex-1 flex-col items-center gap-1">
                        <div className="flex w-full flex-1 flex-col justify-end">
                            <div
                                title={`${p.period} · ${total} terminations`}
                                className="flex w-full flex-col justify-end overflow-hidden rounded-t"
                                style={{ height: `${(total / maxTotal) * 100}%`, minHeight: total > 0 ? 2 : 0 }}
                            >
                                {TYPE_ORDER.map(ty => {
                                    const v = Number(p[ty] || 0);
                                    if (v === 0) return null;
                                    return <div key={ty} style={{ height: `${(v / total) * 100}%`, background: TYPE_META[ty].color }} />;
                                })}
                            </div>
                        </div>
                        <span className="whitespace-nowrap text-[9px] text-[var(--text-tertiary)]">{p.period.slice(5)}</span>
                    </div>
                );
            })}
        </div>
    );
}
