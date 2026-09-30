/** A notification row's two trailing actions: mark read, and delete. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

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
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.actions}>
            <IconButton
                icon={<Icon name={notification.read ? 'Circle' : 'Check'} size={16} color={theme.colors.textMuted} />}
                accessibilityLabel={notification.read ? 'Already read' : `Mark “${notification.title}” as read`}
                disabled={notification.read}
                onPress={onToggleRead}
            />
            <IconButton
                icon={<Icon name="Trash2" size={16} color={theme.colors.error} />}
                accessibilityLabel={`Delete “${notification.title}”`}
                tone="danger"
                disabled={deleting}
                onPress={onDelete}
            />
        </View>
    );
}
