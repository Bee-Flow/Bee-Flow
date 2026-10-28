/**
 * Two-factor: its state, the recovery codes left, and the one action that
 * fits — set it up, or regenerate codes and turn it off. The rows stay direct
 * children of the Group so it can draw the dividers between them.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, InfoRow, SettingRow } from '@/shared/ui';

import { MfaStatusRow, type MfaQuery } from './MfaStatusRow';

export function MfaGroup({
    mfa,
    onSetUp,
    onRegenerate,
    onTurnOff,
}: {
    mfa: MfaQuery;
    onSetUp: () => void;
    onRegenerate: () => void;
    onTurnOff: () => void;
}) {
    const theme = useTheme();
    const t = useTranslation();
    const enabled = Boolean(mfa.data?.enabled);
    const remaining = mfa.data?.recoveryCodesRemaining ?? 0;
    const icon = (name: 'RefreshCw' | 'Shield') => (
        <Icon name={name} size={16} color={theme.colors.textSecondary} />
    );
    return (
        <Group
            title={t('mfa.title', 'Two-factor authentication')}
            footer={t('mobile.security.mfa_footer', 'A code from an authenticator app, on top of your password. If your organisation requires it for administrators, turning it off may lock you out of admin screens.')}
        >
            <MfaStatusRow mfa={mfa} />
            {enabled ? (
                <InfoRow
                    label={t('mobile.security.codes_left', 'Recovery codes left')}
                    value={String(remaining)}
                    tone={remaining <= 2 ? 'warning' : 'tertiary'}
                />
            ) : null}
            {enabled ? (
                <SettingRow
                    label={t('mobile.security.codes_generate', 'Generate new recovery codes')}
                    icon={icon('RefreshCw')}
                    onPress={onRegenerate}
                />
            ) : null}
            {enabled ? (
                <SettingRow
                    label={t('mobile.security.mfa_off_title', 'Turn off two-factor')}
                    destructive
                    icon={<Icon name="ShieldOff" size={16} color={theme.colors.error} />}
                    onPress={onTurnOff}
                />
            ) : (
                <SettingRow label={t('mobile.security.mfa_setup', 'Set up two-factor')} icon={icon('Shield')} onPress={onSetUp} />
            )}
        </Group>
    );
}
