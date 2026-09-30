/** One outstanding pairing code: the code, the time it has left, copy and revoke. */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ListRow, useToast } from '@/shared/ui';

import { countdown } from '../model/nextcloud';
import type { PairingCode } from '../model/nextcloudTypes';

const styles = StyleSheet.create({ actions: { flexDirection: 'row' } });

export function PairingCodeRow({ code, now, onRevoke }: { code: PairingCode; now: number; onRevoke: (code: PairingCode) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const { toast } = useToast();
    const left = countdown(code.expiresAt, now);
    const copy = async () => {
        await Clipboard.setStringAsync(code.code);
        toast(t('mobile.orgIntegrations.pair_copied', 'Copied'), 'success');
    };
    return (
        <ListRow
            testID={`pairing-${code.id}`}
            title={code.code}
            subtitle={left === null ? t('mobile.orgIntegrations.pair_expired', 'expired') : t('mobile.orgIntegrations.pair_left', '{left} remaining', { left })}
            trailing={
                <View style={styles.actions}>
                    <IconButton
                        icon={<Icon name="Copy" size={18} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.orgIntegrations.pair_copy', 'Copy')}
                        onPress={() => void copy()}
                    />
                    <IconButton
                        icon={<Icon name="Trash2" size={18} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('mobile.orgIntegrations.pair_revoke', 'Revoke')}
                        onPress={() => onRevoke(code)}
                    />
                </View>
            }
        />
    );
}
