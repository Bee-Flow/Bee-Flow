import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { DataSummary } from '../flow/types';
import InOutParts from './InOutParts';

/**
 * The "In … → Out …" line on the left of the settings form's footer.
 *
 * Quick density: a button into the full view (that is where the data lives)
 * plus the way into what the small dialog left out: the mode link when the
 * shell owns the mode, else the counted "More options" that opens the full
 * view. Full density: the same line as a plain statement, because the
 * columns it would open are already on screen.
 */
export default function NdvFooterInfo({ quick, inSummary, outSummary, isTrigger, onGoFull, modeLink, hiddenCount }: {
    quick: boolean;
    inSummary: DataSummary | null;
    outSummary: DataSummary | null;
    isTrigger: boolean;
    onGoFull: () => void;
    modeLink: ReactNode;
    hiddenCount: number;
}) {
    const { t } = useTranslation();
    if (!quick) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)] min-w-0" data-testid="ndv-footer-inout">
                <InOutParts t={t} inSummary={inSummary} outSummary={outSummary} isTrigger={isTrigger} valueClass="truncate font-medium text-[var(--text-primary)]" />
            </span>
        );
    }
    return (
        <>
            <button
                type="button"
                onClick={onGoFull}
                title={t('automations.builder.see_data_in_out', 'See the data going in and coming out')}
                data-testid="ndv-footer-inout"
                className="inline-flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] min-w-0"
            >
                <InOutParts t={t} inSummary={inSummary} outSummary={outSummary} isTrigger={isTrigger} valueClass="truncate" />
            </button>
            {modeLink || (
                <button type="button" onClick={onGoFull} className="inline-flex items-center gap-1 shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium">
                    {hiddenCount > 0
                        ? t('automations.ndv.more_options_n', 'More options ({n})', { n: hiddenCount })
                        : t('automations.ndv.more_options', 'More options')} <ChevronRight size={12} />
                </button>
            )}
        </>
    );
}
