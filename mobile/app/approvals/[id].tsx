/**
 * One decision, keyed by APPROVAL id — what `/app/studio/approvals/:id`
 * notification links carry (server/automation/approvalHooks.js), and the only
 * key an App Studio approval, which has no run, can have.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { ApprovalScreen } from '@/features/approvals';

export default function ApprovalRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <ApprovalScreen id={id} />;
}
