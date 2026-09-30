/**
 * Switching servers. Destructive, and the footer says so BEFORE: switching
 * wipes the vault, clears every cached query and signs you out. That is
 * correct — a key derived for one server is meaningless on another, and
 * carrying cached content across would be a cross-tenant leak — but it must
 * never be a surprise.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Group, Icon } from '@/shared/ui';

export function ChangeServerGroup({ onSwitch }: { onSwitch: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <Group
            title={t('mobile.settings.change_server', 'Change server')}
            footer={t('mobile.settings.change_server_footer', "Switching signs you out and clears this phone's cache and stored key. Nothing on either server is deleted.")}
        >
            <View style={styles.actions}>
                <Button
                    label={t('mobile.settings.connect_other', 'Connect to a different server')}
                    variant="secondary"
                    onPress={onSwitch}
                    icon={<Icon name="Repeat" size={16} color={theme.colors.textPrimary} />}
                    fullWidth
                />
            </View>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        actions: { padding: theme.spacing.lg },
    });
