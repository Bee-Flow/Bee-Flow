import { Empty } from './shared';
import { TYPE_ORDER } from '../../../utils/terminationsModel';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TimelineRow, Bucket } from './TerminationsPage.types';
import { TYPE_META } from './TerminationsPage.helpers';

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
        <div className="[display:flex] [align-items:flex-end] [gap:4px] h-[140px] [padding:8px_0]">
            {periods.map(p => {
                const total = TYPE_ORDER.reduce((s, ty) => s + Number(p[ty] || 0), 0);
                const heightPct = (total / maxTotal) * 100;
                return (
                    <div key={p.period} className="[flex:1] [display:flex] [flex-direction:column] [align-items:center] [gap:4px] min-w-[8px]">
                        <div title={`${p.period} · ${total} terminations`} style={{
                            width: '100%', height: `${heightPct}%`, minHeight: total > 0 ? 2 : 0,
                            display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                            borderRadius: '4px 4px 0 0', overflow: 'hidden',
                        }}>
                            {TYPE_ORDER.map(ty => {
                                const v = Number(p[ty] || 0);
                                if (v === 0) return null;
                                return (
                                    <div key={ty} style={{
                                        height: `${(v / total) * 100}%`,
                                        background: TYPE_META[ty].color,
                                    }} />
                                );
                            })}
                        </div>
                        <span className="[font-size:9px] [color:var(--text-muted,#888)] [white-space:nowrap]">
                            {p.period.slice(5)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
