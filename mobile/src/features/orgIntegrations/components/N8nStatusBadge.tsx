/** The n8n status line (N8nSection.jsx StatusPill): the last test wins, else whether it is configured. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge } from '@/shared/ui';

import { n8nStatus } from '../model/n8n';
import type { N8nTestResult } from '../model/n8nTypes';

export function N8nStatusBadge({ configured, test }: { configured: boolean; test: N8nTestResult | null }) {
    const t = useTranslation();
    const status = n8nStatus(configured, test);
    if (status.kind === 'connected') {
        const label =
            status.count === null
                ? t('mobile.orgIntegrations.n8n_connected', 'Connected')
                : t('mobile.orgIntegrations.n8n_connected_count', 'Connected · {n} active webhook workflow(s)', { n: status.count });
        return <Badge testID="n8n-status" label={label} tone="success" icon="CircleCheck" />;
    }
    if (status.kind === 'failed') {
        const failed = t('mobile.orgIntegrations.n8n_failed', 'Connection failed');
        return <Badge testID="n8n-status" label={status.error ? `${failed} — ${status.error}` : failed} tone="error" icon="CircleX" />;
    }
    if (status.kind === 'configured') {
        return <Badge testID="n8n-status" label={t('mobile.orgIntegrations.n8n_configured', 'Configured — tap Test to verify')} icon="Info" />;
    }
    return <Badge testID="n8n-status" label={t('mobile.orgIntegrations.n8n_unconfigured', 'Not configured')} icon="Info" />;
}
