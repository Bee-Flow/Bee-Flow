/**
 * Settings → Your account. The status lines answer the question people open
 * Settings with ("is 2FA on?", "which plan am I on?"), so most visits end here
 * without a tap. Neither probe may fail the screen: a refusal leaves the line
 * blank.
 *
 * Privacy opens YOUR Privacy Shield choices (the web's own word for them), so
 * it sits with the account rather than with the organisation; Memory is what
 * Bee Flow remembers about you.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useMfaStatus } from '@/features/security';
import { useLicenseStatus } from '@/features/usage';
import { humanise } from '@/shared/lib/display';
import { Group, IconTile, SettingRow } from '@/shared/ui';

import { twoFactorLabel } from '../model/labels';

export function HubAccountGroup() {
    const router = useRouter();
    const t = useTranslation();
    const { user } = useAuth();
    const mfa = useMfaStatus({ staleTime: 60_000 });
    const license = useLicenseStatus();
    return (
        <Group title={t('mobile.settings.your_account', 'Your account')}>
            <SettingRow
                label={t('settings.account', 'Account')}
                value={user?.email ?? undefined}
                icon={<IconTile name="User" />}
                onPress={() => router.push('/settings/account')}
            />
            <SettingRow
                label={t('settings.security', 'Security')}
                value={twoFactorLabel(mfa.data)}
                icon={<IconTile name="Lock" />}
                onPress={() => router.push('/settings/security')}
            />
            <SettingRow
                label={t('settings.privacy_shield', 'Privacy Shield')}
                icon={<IconTile name="Shield" />}
                onPress={() => router.push('/org/privacy')}
            />
            <SettingRow
                label={t('settings.memory', 'Memory')}
                icon={<IconTile name="Bookmark" />}
                onPress={() => router.push('/memory')}
            />
            <SettingRow
                label={t('mobile.settings.usage', 'Usage and spend')}
                value={license.data ? humanise(license.data.tier) : undefined}
                icon={<IconTile name="ChartNoAxesColumn" />}
                onPress={() => router.push('/usage')}
            />
        </Group>
    );
}
