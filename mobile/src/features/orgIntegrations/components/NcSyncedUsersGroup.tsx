/**
 * The accounts Nextcloud Sync mirrored (NextcloudSyncPanel.jsx "Synced
 * users"), each with its status. Capped on the phone: a big instance has
 * hundreds, and Users & Groups is where one is looked up.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Badge, Group, ListRow, NoteRow, type Tone } from '@/shared/ui';

import type { NcSyncUser } from '../model/nextcloudTypes';

const SHOWN = 50;

function tone(status: string): Tone {
    if (status === 'active') return 'success';
    if (status === 'pending') return 'warning';
    return 'neutral';
}

export function NcSyncedUsersGroup({ users }: { users: readonly NcSyncUser[] }) {
    const t = useTranslation();
    if (users.length === 0) return null;
    return (
        <Group title={t('mobile.orgIntegrations.nc_synced_users', 'Synced users ({n})', { n: users.length })}>
            {users.slice(0, SHOWN).map((user) => (
                <ListRow
                    key={user.id}
                    title={user.displayName || user.email || user.id}
                    subtitle={user.email ?? undefined}
                    trailing={user.status ? <Badge label={user.status} tone={tone(user.status)} /> : undefined}
                />
            ))}
            {users.length > SHOWN ? (
                <NoteRow>{t('mobile.orgIntegrations.nc_more_users', 'And {n} more — see Users & Groups.', { n: users.length - SHOWN })}</NoteRow>
            ) : null}
        </Group>
    );
}
