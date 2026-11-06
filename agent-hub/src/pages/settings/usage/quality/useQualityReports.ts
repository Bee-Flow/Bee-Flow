import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { RangeParams } from '@/utils/usageHelpers';
import { formatDateRange } from '../format';
import { useFeedbackReport, useTerminationsReport } from './qualityData';
import type { QualityRevealBannerProps } from './QualityRevealBanner';

/** The period the audit row records, in words. */
function useScopeLabel({ days, startDate, endDate }: RangeParams): string {
    const { t } = useTranslation();
    if (startDate && endDate) return formatDateRange(startDate, endDate);
    return days != null ? t('org.quality_scope_days', 'last {n} days', { n: days }) : t('org.quality_scope_all', 'all time');
}

/**
 * Both Quality reports and the name reveal that goes with them.
 *
 * The reveal is page-local, like the Adoption people reveal: leaving the page
 * hides the names again. Only the list on screen asks for them, so one click is
 * one access-audit row.
 */
export function useQualityReports(rangeParams: RangeParams, sub: string) {
    const [reveal, setReveal] = useState(false);
    const revealFeedback = reveal && sub === 'feedback';
    const revealTerminations = reveal && sub === 'terminations';
    const feedback = useFeedbackReport(rangeParams, revealFeedback);
    const terminations = useTerminationsReport(rangeParams, revealTerminations);
    const shownList = sub === 'feedback' ? feedback : terminations;
    const shown = !!shownList.data?.revealed;
    const banner: QualityRevealBannerProps = {
        revealed: reveal,
        shown,
        auditFailed: reveal && !!shownList.data?.auditFailed,
        revealedAt: reveal && shown ? shownList.dataUpdatedAt : null,
        scopeLabel: useScopeLabel(rangeParams),
        loading: shownList.isFetching,
        onReveal: () => setReveal(true),
        onHide: () => setReveal(false),
    };
    return { feedback, terminations, revealFeedback, revealTerminations, banner };
}
