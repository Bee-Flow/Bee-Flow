/**
 * About → Privacy: the publisher's privacy policy, and the way to ask for the
 * account to be deleted. Both are Google Play requirements (an in-app policy
 * link, and an in-app route to account deletion); the deletion route itself
 * lives on the Account screen, where the data request is filed, so this row
 * only takes you there.
 */

import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, SettingRow } from '@/shared/ui';

import { privacyPolicyUrl } from '../model/legal';

export function PrivacyGroup() {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const policy = privacyPolicyUrl();
    return (
        <Group
            title={t('settings.privacy_section', 'Privacy')}
            footer={t(
                'mobile.settings.about_privacy_footer',
                "Your workspace data lives on your organisation's Bee Flow server. To delete your account, file a deletion request under Settings → Account → Your data.",
            )}
        >
            {policy ? (
                <SettingRow
                    label={t('mobile.settings.privacy_policy', 'Privacy policy')}
                    icon={<Icon name="Shield" size={16} color={theme.colors.textSecondary} />}
                    onPress={() => void WebBrowser.openBrowserAsync(policy, { createTask: false })}
                />
            ) : null}
            <SettingRow
                label={t('mobile.settings.delete_account', 'Delete my account')}
                icon={<Icon name="Trash2" size={16} color={theme.colors.textSecondary} />}
                onPress={() => router.push('/settings/account')}
            />
        </Group>
    );
}
