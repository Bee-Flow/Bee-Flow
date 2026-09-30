/**
 * The visible half of the upload queue.
 *
 * One row per file, and every row says which of the four things is true:
 * waiting, this-far-along, done, or failed-and-here-is-why. The failure row
 * keeps the file name and offers Retry, because the whole reason the queue
 * remembers the local uri is so a person never has to find the file twice.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Text } from '@/shared/ui';

import { UploadRow } from './UploadRow';
import type { UploadItem } from '../hooks/useUploadQueue';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        card: {
            borderRadius: theme.radii.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderSubtle,
            backgroundColor: theme.colors.bgCard,
            overflow: 'hidden',
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: theme.spacing.lg,
            paddingRight: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            gap: theme.spacing.sm,
        },
        title: { flex: 1 },
    });

export function UploadQueue({
    items,
    onRetry,
    onRemove,
    onClearFinished,
}: {
    items: UploadItem[];
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
    onClearFinished: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    if (items.length === 0) return null;

    const finished = items.filter((i) => i.status === 'done' || i.status === 'cancelled').length;

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Text variant="label" tone="tertiary" style={styles.title}>
                    UPLOADS
                </Text>
                {finished > 0 ? (
                    <IconButton
                        icon={<Icon name="Check" size={16} color={theme.colors.textMuted} />}
                        accessibilityLabel="Clear finished uploads"
                        onPress={onClearFinished}
                    />
                ) : null}
            </View>

            {/* The queue holds what one person picked in one sitting — bounded. */}
            {items.map((item) => (
                <UploadRow key={item.id} item={item} onRetry={onRetry} onRemove={onRemove} />
            ))}
        </View>
    );
}
