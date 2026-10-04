import { useTranslation } from '../../../../../hooks/useTranslation';
import { cadenceBars, weekdayShort } from './patternView';

/**
 * Bar heights by level (0–6). A class table, not an inline height: Tailwind
 * only generates classes it can read in the source, and the page is under
 * the ratchet on inline style objects.
 */
const LEVEL_HEIGHT = ['h-0.5', 'h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6'] as const;

/**
 * When a pattern happens, as seven weekday bars (Monday first), each as tall
 * as its share of the busiest day. The busiest day is drawn in the trigger
 * colour, the rest in a tint of it; an empty day is a hairline.
 */
export default function CadenceStrip({ histogram }: { histogram: number[] }) {
    const { t } = useTranslation();
    const bars = cadenceBars(histogram);
    const top = Math.max(...bars.map(b => b.level));
    if (top === 0) return null;
    const days = bars.map(b => `${weekdayShort(b.day, t)} ${b.count}`).join(', ');
    return (
        <div role="img" aria-label={t('automations.repeating.cadenceStrip', 'By weekday: {days}', { days })} className="flex items-end gap-1 shrink-0" data-testid="cadence-strip">
            {bars.map(b => {
                let tone = 'bg-[var(--border-default)]';
                if (b.level === top) tone = 'bg-[var(--type-trigger)]';
                else if (b.level > 0) tone = 'bg-[color-mix(in_srgb,var(--type-trigger)_40%,transparent)]';
                return (
                    <span key={b.day} className="flex flex-col items-center gap-0.5" aria-hidden="true">
                        <span className="h-6 flex items-end">
                            <span className={`block w-1.5 rounded-sm ${LEVEL_HEIGHT[b.level]} ${tone}`} data-level={b.level} />
                        </span>
                        <span className="text-[8px] leading-none text-[var(--text-tertiary)]">{weekdayShort(b.day, t).charAt(0)}</span>
                    </span>
                );
            })}
        </div>
    );
}
