/**
 * Where an approval comes from and, once decided, who decided it and why.
 * Its deadline is not here: the heading says it, as a date (ApprovalBody).
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { Group, InfoRow } from '@/shared/ui';

import type { Approval } from '../model/types';

export function ApprovalFacts({ approval }: { approval: Approval }) {
    const t = useTranslation();
    const decider = approval.decidedByName || t('mobile.approvals.someone', 'Someone');
    return (
        <Group>
            {approval.projectTitle ? (
                <InfoRow label={t('mobile.approvals.fact_solution', 'Solution')} value={approval.projectTitle} />
            ) : null}
            {approval.automationTitle ? (
                <InfoRow label={t('mobile.approvals.fact_automation', 'Automation')} value={approval.automationTitle} />
            ) : null}
            {approval.decidedAt ? (
                <InfoRow
                    label={t('mobile.approvals.fact_decided', 'Decided')}
                    value={[decider, timeAgo(approval.decidedAt, { suffix: true })].filter(Boolean).join(' · ')}
                />
            ) : null}
            {approval.decisionReason ? (
                <InfoRow label={t('mobile.approvals.fact_reason', 'Reason given')} value={approval.decisionReason} />
            ) : null}
        </Group>
    );
}
