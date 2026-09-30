/**
 * AI usage sharing (OrgLicenseSection.jsx, moved there from Org Info): one
 * budget for the whole organisation, or an equal slice per active user. Only
 * offered when the plan sets a cost budget, which is the only thing it splits.
 * The switch saves at once (PUT /auth/organizations/:id `{ usagePooled }`);
 * it says the current state, the footer what the two states mean.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ToggleRow } from '@/shared/ui';

export function UsageSharingGroup({
    pooled,
    saving,
    onChange,
}: {
    pooled: boolean;
    saving: boolean;
    onChange: (pooled: boolean) => void;
}) {
    const t = useTranslation();
    return (
        <Group
            title={t('org.share_usage', 'AI usage sharing')}
            footer={t(
                'org.share_usage_explainer',
                "When on, every user shares the plan's cost budget. When off, the budget is divided equally between active users so each user gets their own slice for the period.",
            )}
        >
            <ToggleRow
                testID="billing-usage-pooled"
                label={t('org.share_usage_label', 'Share AI usage across the organisation')}
                description={pooled ? t('org.share_usage_on', 'Pooled across the organisation') : t('org.share_usage_off', 'Each user has their own budget')}
                value={pooled}
                disabled={saving}
                onValueChange={onChange}
            />
        </Group>
    );
}
