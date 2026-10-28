/** A connector's state in one badge, or none when it is simply not connected. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge } from '@/shared/ui';

export function ConnectorBadge({
    needsReauth,
    connected,
    notConfigured,
}: {
    needsReauth: boolean;
    connected: boolean;
    notConfigured: boolean;
}) {
    const t = useTranslation();
    if (needsReauth) return <Badge label={t('mobile.integrations.badge_reauth', 'Needs re-authorising')} tone="warning" />;
    if (connected) return <Badge label={t('settings.connected', 'Connected')} tone="success" />;
    if (notConfigured) return <Badge label={t('mobile.integrations.badge_not_set_up', 'Not set up')} tone="neutral" />;
    return null;
}
