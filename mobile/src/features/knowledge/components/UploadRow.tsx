/**
 * One file in the upload queue. The progress bar is a live region: on a
 * screen reader, "43 percent" spoken occasionally is the difference between a
 * working upload and a frozen app.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
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

function statusLabel(t: TranslateFn, status: UploadItem['status']): string {
    switch (status) {
        case 'queued':
            return t('automations.trigger_editors.waiting', 'Waiting');
        case 'uploading':
            return t('mobile.knowledge.upload_uploading', 'Uploading');
        case 'done':
            return t('mobile.knowledge.upload_done', 'Uploaded');
        case 'error':
            return t('automations.ndv.quick_failed', 'Failed');
        case 'cancelled':
            return t('mobile.knowledge.upload_cancelled', 'Cancelled');
    }
}

/** The line under the name: a progress bar, the error, or the plain status. */
function UploadDetail({ item }: { item: UploadItem }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const percent = Math.round(item.progress * 100);
    const size = item.size ? formatBytes(item.size) : '';

    if (item.status === 'uploading') {
        return (
            <View
                accessibilityLiveRegion="polite"
                accessibilityLabel={t('mobile.knowledge.upload_progress_label', 'Uploading {name}, {percent} percent', { name: item.name, percent })}
                style={styles.progress}
            >
                <View style={styles.track}>
                    <View style={[styles.fill, { width: `${Math.max(2, percent)}%` }]} />
                </View>
                <Text variant="label" tone="tertiary">
                    {size ? t('mobile.knowledge.upload_progress_of', '{percent}% of {size}', { percent, size }) : `${percent}%`}
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
            {statusLabel(t, item.status)}
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
    const t = useTranslation();
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
                    accessibilityLabel={t('mobile.knowledge.upload_retry', 'Retry uploading {name}', { name: item.name })}
                    onPress={() => onRetry(item.id)}
                />
            ) : null}
            {item.status !== 'done' ? (
                <IconButton
                    icon={<Icon name="X" size={16} color={theme.colors.textMuted} />}
                    accessibilityLabel={
                        item.status === 'uploading'
                            ? t('mobile.knowledge.upload_cancel', 'Cancel uploading {name}', { name: item.name })
                            : t('mobile.knowledge.upload_remove', 'Remove {name} from the queue', { name: item.name })
                    }
                    onPress={() => onRemove(item.id)}
                />
            ) : null}
        </View>
    );
}
