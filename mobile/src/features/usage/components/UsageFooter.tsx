/** Where the rest of the numbers live: for an org admin, the organisation's Usage & Monitoring. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useIsOrgAdmin } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { Group, ListRow } from '@/shared/ui';

export function UsageFooter() {
    const t = useTranslation();
    const router = useRouter();
    const admin = useIsOrgAdmin();
    if (!admin) return null;
    return (
        <Group>
            <ListRow
                testID="usage-org-monitoring"
                title={t('settings.usage_monitoring', 'Usage & Monitoring')}
                subtitle={t('mobile.usage.org_monitoring_row', 'Per user, per agent and feedback, for the whole organisation')}
                chevron
                onPress={() => router.push('/org/usage')}
            />
        </Group>
    );
}
