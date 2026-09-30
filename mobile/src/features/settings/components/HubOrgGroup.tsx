/**
 * Settings → Your organisation: its profile and settings (the org index lists
 * every section an org admin may configure) and integrations. The web's
 * super-admin dashboard is out of the phone's scope, so there is no
 * Administration row. Your own privacy choices sit under Your account.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useAccess } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { Group, IconTile, SettingRow } from '@/shared/ui';

export function HubOrgGroup() {
    const router = useRouter();
    const t = useTranslation();
    const access = useAccess();
    return (
        <Group title={t('datatables.scope_org', 'Your organisation')}>
            <SettingRow
                label={t('settings.organisation', 'Organisation')}
                value={access.organization?.name || undefined}
                icon={<IconTile name="Briefcase" />}
                onPress={() => router.push('/org')}
            />
            <SettingRow
                label={t('settings.integrations', 'Integrations')}
                icon={<IconTile name="Link" />}
                onPress={() => router.push('/integrations')}
            />
        </Group>
    );
}
