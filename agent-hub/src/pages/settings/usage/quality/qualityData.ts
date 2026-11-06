import { feedbackRangeQuery, terminationsRangeQuery, useOrgFeedbackQuery, useOrgTerminationsQuery } from '@/api/queries/orgReports';
import type { RangeParams } from '@/utils/usageHelpers';
import type { ByAgentRow, TerminationRow, TerminationsSummary, TimelinePoint } from '@/pages/settings/OrgTerminationsPanel.types';

/** One feedback record as `GET /api/feedback/org` sends it. */
export interface FeedbackItem {
    id: string;
    rating?: string;
    comment?: string;
    conversation_snapshot?: string;
    conversation_id?: string;
    message_id?: string;
    agent_id: string;
    agent_name?: string;
    user_id?: string;
    source?: string;
    model?: string;
    model_tier?: string;
    created_at?: string;
}

/** The panels and the hero read the same keys, so react-query answers both from one request. */
export function useFeedbackReport(rangeParams: RangeParams) {
    return useOrgFeedbackQuery<FeedbackItem>(feedbackRangeQuery(rangeParams));
}

export function useTerminationsReport(rangeParams: RangeParams) {
    return useOrgTerminationsQuery<TerminationsSummary, TimelinePoint, TerminationRow, ByAgentRow>(
        terminationsRangeQuery(rangeParams),
        rangeParams?.interval || 'day',
    );
}
