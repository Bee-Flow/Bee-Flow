import { useTranslation } from '@/hooks/useTranslation';
import { formatDelta, type DeltaUnit } from './delta';

export interface DeltaProps {
    delta: number | null;
    unit: DeltaUnit;
    /** A fall is the good direction (cost, dormant seats). */
    goodWhenDown?: boolean;
}

export interface DeltaPillProps extends DeltaProps {
    /** Off hides the pill: the page-wide "Compare with previous period" switch. */
    compare: boolean;
}

const TONE = {
    good: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]',
    bad: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]',
    neutral: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};

export function DeltaPill({ delta, unit, goodWhenDown = false, compare }: DeltaPillProps) {
    const { t } = useTranslation();
    if (!compare) return null;
    const formatted = formatDelta(delta, unit, { same: t('usage.delta_same', 'same'), pts: t('usage.delta_pts', 'pts') });
    if (!formatted) return null;
    const { direction, text } = formatted;
    const tone = direction === 'same' ? TONE.neutral : (direction === 'down') === goodWhenDown ? TONE.good : TONE.bad;
    return (
        <span data-testid="delta-pill" className={`inline-flex items-center gap-1 rounded-md px-[7px] py-[3px] text-xs font-semibold ${tone}`}>
            {text}
        </span>
    );
}
