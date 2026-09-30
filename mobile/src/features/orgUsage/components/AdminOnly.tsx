/** The reports are the organisation's, and org-admin only on the server: the org's own locked screen, saying where a member's usage is. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgLockedScreen } from '@/features/org';

export function AdminOnly() {
    const t = useTranslation();
    const denied = {
        icon: 'BarChart3' as const,
        title: t('mobile.orgUsage.admin_only_title', 'Organisation reports are for administrators'),
        message: t('mobile.orgUsage.admin_only_message', 'Your own usage and costs are under Settings → Usage.'),
    };
    return <OrgLockedScreen title={t('settings.usage_monitoring', 'Usage & Monitoring')} denied={denied} />;
}
