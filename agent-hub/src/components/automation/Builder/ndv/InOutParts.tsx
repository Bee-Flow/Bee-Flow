import { ArrowRight } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { DataSummary } from '../flow/types';

/**
 * The four pieces of the "In … → Out …" footer line, written ONCE so the
 * quick and full densities can never say it in two languages (they did).
 */
export default function InOutParts({ t, inSummary, outSummary, isTrigger, valueClass }: {
    t: TranslateFn;
    inSummary: DataSummary | null;
    outSummary: DataSummary | null;
    isTrigger: boolean;
    valueClass: string;
}) {
    return (
        <>
            <span className="text-[var(--text-tertiary)]">{t('automations.ndv.in', 'In')}</span>
            <span className={valueClass}>{inSummary?.label || '—'}</span>
            <ArrowRight size={11} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[var(--text-tertiary)]">{t('automations.ndv.out', 'Out')}</span>
            <span className={valueClass}>
                {outSummary?.label || (isTrigger ? '—' : t('automations.ndv.not_run_yet', 'not run yet'))}
            </span>
        </>
    );
}
