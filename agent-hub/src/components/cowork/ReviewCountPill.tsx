/**
 * "2 to review": the runs that wait for their owner, on a Cowork row (that item's) and in the list header (all of
 * them). Nothing when there are none: a permanent "0 to review" is a fact nobody asked for.
 */
import { useTranslation } from '../../hooks/useTranslation';

export default function ReviewCountPill({ count, testId }: { count: number; testId: string }) {
    const { t } = useTranslation();
    if (!(count > 0)) return null;
    return (
        <span
            data-testid={testId}
            className="flex-shrink-0 px-1.5 rounded-full text-[10px] font-medium [background:color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)]"
        >
            {t('cowork_review.list.count', '{count} to review', { count })}
        </span>
    );
}
