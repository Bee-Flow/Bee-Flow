/**
 * The password. An SSO-only account holds no password, so the change row is
 * disabled for it and the footer says why.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, SettingRow } from '@/shared/ui';

import type { MfaStatus } from '../model/types';

export function PasswordGroup({
    mfa,
    onChange,
}: {
    mfa: MfaStatus | null | undefined;
    onChange: () => void;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const noPassword = Boolean(mfa && !mfa.hasPassword);
    return (
        <Group
            title={t('login.password', 'Password')}
            footer={
                noPassword
                    ? t('mobile.security.password_sso', 'This account signs in through your identity provider, so Bee Flow holds no password to change.')
                    : t('mobile.security.password_footer', 'Your password also unlocks your encrypted data, so changing it asks for the current one.')
            }
        >
            <SettingRow
                label={t('changepw.title', 'Change password')}
                icon={<Icon name="Key" size={16} color={theme.colors.textSecondary} />}
                disabled={noPassword}
                onPress={onChange}
            />
        </Group>
    );
}
