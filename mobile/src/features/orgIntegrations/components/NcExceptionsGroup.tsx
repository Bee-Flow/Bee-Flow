/**
 * The per-group exceptions of OrgNcIntegrationsPanel: one row per synced
 * Nextcloud group with how many tools it has off, each opening NcGroupSheet.
 * With no groups synced yet, the way to Nextcloud Sync.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, Group, ListRow, NoteRow } from '@/shared/ui';

import type { NcIntegrationGroup } from '../model/types';

export function NcExceptionsGroup({ groups, onOpen }: { groups: readonly NcIntegrationGroup[] | undefined; onOpen: (groupId: string) => void }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <Group
            title={t('mobile.orgIntegrations.nc_exceptions', 'Per-group exceptions')}
            footer={t('mobile.orgIntegrations.nc_exceptions_footer', "Switch a tool off for one group. Everyone else keeps the organisation's setting.")}
        >
            {(groups ?? []).map((group) => (
                <ListRow
                    key={group.id}
                    testID={`nc-group-row-${group.id}`}
                    title={group.name}
                    subtitle={t('mobile.orgIntegrations.members', '{n} members', { n: group.userCount })}
                    trailing={
                        group.disabledIntegrations.length > 0 ? (
                            <Badge label={t('mobile.orgIntegrations.nc_disabled_count', '{n} disabled', { n: group.disabledIntegrations.length })} tone="warning" />
                        ) : undefined
                    }
                    chevron
                    onPress={() => onOpen(group.id)}
                />
            ))}
            {groups && groups.length === 0 ? (
                <>
                    <NoteRow>
                        {t(
                            'mobile.orgIntegrations.nc_no_groups',
                            'No Nextcloud groups synced yet. Sync runs automatically every 6 hours, or use "Sync now" in Nextcloud Sync.',
                        )}
                    </NoteRow>
                    <ListRow
                        testID="nc-open-sync"
                        title={t('settings.nextcloud_sync', 'Nextcloud Sync')}
                        chevron
                        onPress={() => router.push('/org/nextcloud')}
                    />
                </>
            ) : null}
        </Group>
    );
}
