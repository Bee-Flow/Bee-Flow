/**
 * Signing out of this phone. The server keeps sessions in a store keyed by
 * cookie and exposes no list-my-sessions or revoke-all endpoint, so rather
 * than invent one, the footer says what signing out here does and does not do.
 */

import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useConfirm } from '@/shared/patterns';
import { Group, Icon, SettingRow } from '@/shared/ui';

export function SessionsGroup() {
    const theme = useTheme();
    const t = useTranslation();
    const confirm = useConfirm();
    const { signOut } = useAuth();

    const confirmSignOut = async () => {
        const ok = await confirm({
            title: t('mobile.security.sign_out_title', 'Sign out of this phone?'),
            message: t('mobile.security.sign_out_message', 'Your encryption key is removed from this phone. Your other devices stay signed in.'),
            confirmLabel: t('mobile.security.sign_out', 'Sign out'),
        });
        if (ok) void signOut();
    };

    return (
        <Group footer={t('mobile.security.sign_out_footer', 'Signs you out here and removes your key from this phone. Other devices stay signed in; sign out on each of them separately.')}>
            <SettingRow
                label={t('mobile.security.sign_out_row', 'Sign out of this phone')}
                destructive
                icon={<Icon name="LogOut" size={16} color={theme.colors.error} />}
                onPress={() => void confirmSignOut()}
            />
        </Group>
    );
}
