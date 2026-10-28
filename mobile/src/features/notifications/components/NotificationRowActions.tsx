/** A notification row's two trailing actions: mark read, and delete. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton } from '@/shared/ui';

import type { AppNotification } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ actions: { gap: theme.spacing.xs } });

export function NotificationRowActions({
    notification,
    onToggleRead,
    onDelete,
    deleting,
}: {
    notification: AppNotification;
    onToggleRead: () => void;
    onDelete: () => void;
    deleting: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.actions}>
            <IconButton
                icon={<Icon name={notification.read ? 'Circle' : 'Check'} size={16} color={theme.colors.textMuted} />}
                accessibilityLabel={
                    notification.read
                        ? t('mobile.notifications.already_read', 'Already read')
                        : t('mobile.notifications.mark_one_read', 'Mark “{title}” as read', { title: notification.title })
                }
                disabled={notification.read}
                onPress={onToggleRead}
            />
            <IconButton
                icon={<Icon name="Trash2" size={16} color={theme.colors.error} />}
                accessibilityLabel={t('mobile.notifications.delete_one', 'Delete “{title}”', { title: notification.title })}
                tone="danger"
                disabled={deleting}
                onPress={onDelete}
            />
        </View>
    );
}
