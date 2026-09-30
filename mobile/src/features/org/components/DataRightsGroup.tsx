/** Where a person files a data request about themselves: the Account screen. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, SettingRow } from '@/shared/ui';

export function DataRightsGroup() {
    const theme = useTheme();
    const router = useRouter();
    return (
        <Group
            title="Your data rights"
            footer="Bee Flow answers within thirty days, as the GDPR requires."
        >
            <SettingRow
                label="Request a copy, correction or deletion"
                icon={<Icon name="FileText" size={16} color={theme.colors.textSecondary} />}
                onPress={() => router.push('/settings/account')}
            />
        </Group>
    );
}
