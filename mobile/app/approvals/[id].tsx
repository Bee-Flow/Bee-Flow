/**
 * One decision, keyed by APPROVAL id — what `/app/studio/approvals/:id`
 * notification links carry (server/automation/approvalHooks.js), and the only
 * key an App Studio approval, which has no run, can have.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ApprovalScreen } from '@/features/approvals';

export default function ApprovalRoute() {
    // `?decide=approve`: a run screen sent an approval that asks for answers
    // here, so the decide sheet opens at once (features/automations useRunDecision).
    const { id, decide } = useLocalSearchParams<{ id: string; decide?: string }>();
    return <ApprovalScreen id={id} initialDecision={decide === 'approve' || decide === 'reject' ? decide : null} />;
}
