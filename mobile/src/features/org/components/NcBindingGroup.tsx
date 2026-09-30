/**
 * The web's "Provisioned through Nextcloud" banner on Organisation Info: which
 * Nextcloud instance owns this organisation's identity, and how it syncs.
 * Read-only; the binding is managed from Nextcloud Sync.
 */

import React from 'react';

import type { NcOrgBinding } from '@/core/auth/types';
import { formatWhen, useTranslation } from '@/core/i18n';
import { Group, InfoRow } from '@/shared/ui';

export function NcBindingGroup({ binding }: { binding: NcOrgBinding }) {
    const t = useTranslation();
    return (
        <Group
            title={t('mobile.org.nc_title', 'Provisioned through Nextcloud')}
            footer={t(
                'mobile.org.nc_message',
                'User accounts and authentication are managed by your Nextcloud instance. Sign-in method and allowed-domain settings are not shown here.',
            )}
        >
            {binding.baseUrl ? (
                <InfoRow label={t('mobile.org.nc_instance', 'Instance')} value={binding.baseUrl} selectable />
            ) : null}
            <InfoRow
                label={t('mobile.org.nc_sync', 'Sync')}
                value={(binding.syncMode || 'mirror_all').replace('_', ' ')}
            />
            {binding.lastSyncAt ? (
                <InfoRow
                    label={t('mobile.org.nc_last_sync', 'Last sync')}
                    value={formatWhen(binding.lastSyncAt)}
                />
            ) : null}
        </Group>
    );
}
