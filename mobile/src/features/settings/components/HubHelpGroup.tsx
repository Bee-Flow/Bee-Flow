/** Settings → Help: support requests, and the About screen. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, IconTile, SettingRow } from '@/shared/ui';

export function HubHelpGroup() {
    const router = useRouter();
    const t = useTranslation();
    return (
        <Group title={t('mobile.settings.help', 'Help')}>
            <SettingRow
                label={t('settings.help_support', 'Help & Support')}
                icon={<IconTile name="LifeBuoy" />}
                onPress={() => router.push('/support')}
            />
            <SettingRow
                label={t('mobile.settings.about', 'About Bee Flow')}
                icon={<IconTile name="Info" />}
                onPress={() => router.push('/settings/about')}
            />
        </Group>
    );
}
