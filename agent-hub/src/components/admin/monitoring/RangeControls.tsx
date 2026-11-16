import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import RangeControl, { type UsageRange } from '@/components/shared/RangeControl';
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

/** The monitor's presets, in the shared control's order. */
const PRESETS = RANGES.map(r => r.id);

/**
 * The period (Today / 7d / 30d / All / Custom, with the custom from/to
 * pickers) in the one shared RangeControl that Website analytics and the
 * Privacy Shield use too, and Refresh.
 */
export function RangeControls({ range, setRange, customStart, setCustomStart, customEnd, setCustomEnd, loading, onRefresh }: RangeControlsProps) {
    const { t } = useTranslation();
    const value = useMemo<UsageRange>(() => ({ preset: range, customStart, customEnd }), [range, customStart, customEnd]);
    const onChange = (next: UsageRange) => {
        if (next.customStart !== customStart) setCustomStart(next.customStart);
        if (next.customEnd !== customEnd) setCustomEnd(next.customEnd);
        if (next.preset !== range) setRange(next.preset);
    };
    return (
        <div className="flex flex-wrap items-center justify-end gap-2">
            <RangeControl range={value} onChange={onChange} t={t} presets={PRESETS} />
            <button
                type="button"
                onClick={onRefresh}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] transition hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                title={t('admin_monitoring.refresh', 'Refresh')}
                aria-label={t('admin_monitoring.refresh', 'Refresh')}
                aria-busy={loading || undefined}
            >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
        </div>
    );
}
