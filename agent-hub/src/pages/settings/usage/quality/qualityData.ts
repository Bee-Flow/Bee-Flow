import { feedbackRangeQuery, terminationsRangeQuery, useOrgFeedbackQuery, useOrgTerminationsQuery } from '@/api/queries/orgReports';
import type { RangeParams } from '@/utils/usageHelpers';
import type { ByAgentRow, TerminationRow, TerminationsSummary, TimelinePoint } from '@/pages/settings/OrgTerminationsPanel.types';

/**
 * The person behind a row. By default a pseudonym ("Member · K7Q2", the label the
 * Adoption tab shows for the same person); after an audited reveal their display name.
 */
export interface QualityPerson {
    id: string;
    name: string;
    avatar?: string | null;
    avatarType?: string | null;
}

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
    /** Null for an anonymous rating. */
    person?: QualityPerson | null;
    source?: string;
    model?: string;
    model_tier?: string;
    created_at?: string;
}

/** With `reveal` the list asks for names (audited by the server). The panels and the hero read the same keys, so react-query answers both from one request. */
export function useFeedbackReport(rangeParams: RangeParams, reveal = false) {
    return useOrgFeedbackQuery<FeedbackItem>(feedbackRangeQuery(rangeParams), reveal);
}

export function useTerminationsReport(rangeParams: RangeParams, reveal = false) {
    return useOrgTerminationsQuery<TerminationsSummary, TimelinePoint, TerminationRow, ByAgentRow>(
        terminationsRangeQuery(rangeParams),
        rangeParams?.interval || 'day',
        reveal,
    );
}
