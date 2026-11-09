import { Calendar, RefreshCw } from 'lucide-react';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { useTranslation } from '@/hooks/useTranslation';
import { RANGES } from './monitoring.constants';

interface RangeControlsProps {
    range: string;
    setRange: (range: string) => void;
    customStart: string;
    setCustomStart: (value: string) => void;
    customEnd: string;
    setCustomEnd: (value: string) => void;
    loading: boolean;
    onRefresh: () => void;
}

const DATE_INPUT = 'h-8 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)] outline-none [color-scheme:light_dark] focus:border-[var(--accent-primary)]';
const DATE_LABEL = 'flex flex-col gap-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]';

/** The range (Today / 7 days / 30 days / All time / Custom), the custom from/to pickers, and Refresh. */
export function RangeControls({ range, setRange, customStart, setCustomStart, customEnd, setCustomEnd, loading, onRefresh }: RangeControlsProps) {
    const { t } = useTranslation();
    const options = RANGES.map(r => ({
        value: r.id,
        label: r.label ? t(r.labelKey, r.label) : t(r.labelKey),
        icon: r.id === 'custom' ? <Calendar className="h-3 w-3" aria-hidden="true" /> : undefined,
    }));
    return (
        <div className="flex flex-wrap items-end justify-end gap-2">
            <SegmentedControl size="sm" value={range} onChange={setRange} options={options} ariaLabel={t('admin_monitoring.range_label', 'Period')} className="max-w-full overflow-x-auto" />
            {range === 'custom' && (
                <div className="flex items-end gap-1.5">
                    <label className={DATE_LABEL}>
                        {t('admin_monitoring.from', 'From')}
                        <input type="datetime-local" value={customStart} onChange={e => setCustomStart(e.target.value)} max={customEnd} className={DATE_INPUT} />
                    </label>
                    <span className="pb-2 text-xs text-[var(--text-tertiary)]" aria-hidden="true">→</span>
                    <label className={DATE_LABEL}>
                        {t('admin_monitoring.to', 'To')}
                        <input type="datetime-local" value={customEnd} onChange={e => setCustomEnd(e.target.value)} min={customStart} className={DATE_INPUT} />
                    </label>
                </div>
            )}
            <button
                type="button"
                onClick={onRefresh}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] transition hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                title={t('admin_monitoring.refresh', 'Refresh')}
                aria-label={t('admin_monitoring.refresh', 'Refresh')}
                aria-busy={loading || undefined}
            >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
        </div>
    );
}
