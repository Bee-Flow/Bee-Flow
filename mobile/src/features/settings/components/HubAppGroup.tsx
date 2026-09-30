/** Settings → This app: how it looks, speaks, notifies, and which server it talks to. */

import { useRouter } from 'expo-router';
import React from 'react';

import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { themeLabel } from '@/features/appearance';
import { Group, IconTile, SettingRow } from '@/shared/ui';

import { hostOf } from '../model/labels';

export function HubAppGroup() {
    const theme = useTheme();
    const router = useRouter();
    const t = useTranslation();
    return (
        <Group title={t('mobile.settings.this_app', 'This app')}>
            <SettingRow
                label={t('settings.appearance', 'Appearance')}
                value={themeLabel(theme.preference)}
                icon={<IconTile name="Droplet" />}
                onPress={() => router.push('/settings/appearance')}
            />
            <SettingRow
                label={t('settings.language', 'Language')}
                icon={<IconTile name="Globe" />}
                onPress={() => router.push('/settings/language')}
            />
            <SettingRow
                label={t('settings.notifications', 'Notifications')}
                icon={<IconTile name="Bell" />}
                onPress={() => router.push('/settings/notifications')}
            />
            <SettingRow
                label={t('mobile.settings.server', 'Server')}
                value={hostOf(getServerUrl()) ?? undefined}
                icon={<IconTile name="Server" />}
                onPress={() => router.push('/settings/server')}
            />
        </Group>
    );
}
