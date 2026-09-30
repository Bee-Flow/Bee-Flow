/**
 * The Nextcloud binding at a glance (NextcloudSyncPanel.jsx's stat row): the
 * instance, the sync mode, active against mirrored accounts, and when it last
 * synced — plus Sync now, which a Manual-only mode leaves nothing to do.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { Button, Group, InfoRow } from '@/shared/ui';

import { activeUsers, instanceHost, syncFreshness, syncModeLabel } from '../model/nextcloud';
import type { NcSync, NcSyncUser } from '../model/nextcloudTypes';

export function NcSyncStatusGroup({
    sync,
    users,
    syncing,
    onSyncNow,
}: {
    sync: NcSync;
    users: readonly NcSyncUser[];
    syncing: boolean;
    onSyncNow: () => void;
}) {
    const t = useTranslation();
    const fresh = syncFreshness(sync.lastSyncAt);
    return (
        <Group title={t('settings.nextcloud_sync', 'Nextcloud Sync')}>
            <InfoRow label={t('mobile.orgIntegrations.nc_instance', 'Instance')} value={instanceHost(sync)} selectable />
            <InfoRow label={t('mobile.orgIntegrations.nc_mode', 'Sync mode')} value={syncModeLabel(sync.mode, t)} />
            <InfoRow label={t('org.active_users', 'Active users')} value={`${activeUsers(users)} / ${users.length}`} />
            <InfoRow
                label={t('mobile.orgIntegrations.nc_last_sync', 'Last sync')}
                value={sync.lastSyncAt ? timeAgo(sync.lastSyncAt, { suffix: true }) : t('mobile.orgIntegrations.never', 'never')}
                tone={fresh === 'fresh' ? 'success' : fresh === 'stale' ? 'warning' : 'tertiary'}
            />
            <Button
                testID="nc-sync-now"
                label={t('mobile.orgIntegrations.nc_sync_now', 'Sync now')}
                iconName="RefreshCw"
                loading={syncing}
                disabled={sync.mode === 'manual'}
                accessibilityHint={
                    sync.mode === 'manual'
                        ? t('mobile.orgIntegrations.nc_sync_manual_hint', 'Sync mode is set to Manual — change to mirror or selective to enable.')
                        : undefined
                }
                onPress={onSyncNow}
            />
        </Group>
    );
}
