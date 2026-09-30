/**
 * An outbox row's middle: the upload's progress while it runs, or the reason
 * it failed — with the reassurance that matters most, that the audio is safe.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, ProgressBar, Text } from '@/shared/ui';

import type { PendingRecording } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        progress: { gap: theme.spacing.xs },
        failure: {
            flexDirection: 'row',
            gap: theme.spacing.sm,
            padding: theme.spacing.md,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
        },
        failureIcon: { marginTop: 2 },
        failureText: { flex: 1, gap: 2 },
    });

export function OutboxRowProgress({ item }: { item: PendingRecording }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (item.status === 'uploading') {
        const percent = Math.round(item.progress * 100);
        return (
            <View style={styles.progress} accessibilityLiveRegion="polite">
                <ProgressBar fraction={item.progress} label={`Uploading ${item.settings.title || item.fileName}`} />
                <Text variant="caption" tone="tertiary">
                    {percent < 100 ? `Uploading — ${percent}%` : 'Uploaded. Waiting for the server to accept it…'}
                </Text>
            </View>
        );
    }

    if (item.status !== 'failed' || !item.error) return null;
    return (
        <View style={styles.failure}>
            <Icon name="TriangleAlert" size={14} color={theme.colors.warning} style={styles.failureIcon} />
            <View style={styles.failureText}>
                <Text variant="caption" tone="secondary">
                    {item.error}
                </Text>
                <Text variant="caption" tone="tertiary">
                    The audio is safe on this phone. Nothing is lost by trying again.
                </Text>
            </View>
        </View>
    );
}
