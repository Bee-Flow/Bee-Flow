/**
 * One file in the upload queue. The progress bar is a live region: on a
 * screen reader, "43 percent" spoken occasionally is the difference between a
 * working upload and a frozen app.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { formatBytes } from '@/shared/lib/bytes';
import { Icon, IconButton, Text } from '@/shared/ui';

import { UploadStatusGlyph } from './UploadStatusGlyph';
import type { UploadItem } from '../hooks/useUploadQueue';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.borderSubtle,
        },
        body: { flex: 1, gap: theme.spacing.xs },
        progress: { gap: 4 },
        track: {
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.bgTertiary,
            overflow: 'hidden',
        },
        fill: { height: '100%', backgroundColor: theme.colors.accentPrimary },
    });

const LABELS: Record<UploadItem['status'], string> = {
    queued: 'Waiting',
    uploading: 'Uploading',
    done: 'Uploaded',
    error: 'Failed',
    cancelled: 'Cancelled',
};

/** The line under the name: a progress bar, the error, or the plain status. */
function UploadDetail({ item }: { item: UploadItem }) {
    const styles = useThemedStyles(makeStyles);
    const percent = Math.round(item.progress * 100);
    const size = item.size ? formatBytes(item.size) : '';

    if (item.status === 'uploading') {
        return (
            <View
                accessibilityLiveRegion="polite"
                accessibilityLabel={`Uploading ${item.name}, ${percent} percent`}
                style={styles.progress}
            >
                <View style={styles.track}>
                    <View style={[styles.fill, { width: `${Math.max(2, percent)}%` }]} />
                </View>
                <Text variant="label" tone="tertiary">
                    {percent}%{size ? ` of ${size}` : ''}
                </Text>
            </View>
        );
    }
    if (item.status === 'error') {
        return (
            <Text variant="label" tone="error" accessibilityLiveRegion="polite">
                {item.error}
            </Text>
        );
    }
    return (
        <Text variant="label" tone="tertiary">
            {LABELS[item.status]}
            {size ? ` · ${size}` : ''}
        </Text>
    );
}

export function UploadRow({
    item,
    onRetry,
    onRemove,
}: {
    item: UploadItem;
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    return (
        <View style={styles.row}>
            <UploadStatusGlyph status={item.status} />

            <View style={styles.body}>
                <Text variant="caption" numberOfLines={1}>
                    {item.name}
                </Text>
                <UploadDetail item={item} />
            </View>

            {item.status === 'error' ? (
                <IconButton
                    icon={<Icon name="RotateCw" size={16} color={theme.colors.accentPrimary} />}
                    accessibilityLabel={`Retry uploading ${item.name}`}
                    onPress={() => onRetry(item.id)}
                />
            ) : null}
            {item.status !== 'done' ? (
                <IconButton
                    icon={<Icon name="X" size={16} color={theme.colors.textMuted} />}
                    accessibilityLabel={
                        item.status === 'uploading'
                            ? `Cancel uploading ${item.name}`
                            : `Remove ${item.name} from the queue`
                    }
                    onPress={() => onRemove(item.id)}
                />
            ) : null}
        </View>
    );
}
