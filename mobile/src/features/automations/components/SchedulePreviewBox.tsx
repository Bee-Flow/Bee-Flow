/**
 * The schedule in words, and the next three firing times as the SERVER
 * computes them — the same `cron.nextRunAt` the scheduler uses, so they are
 * the times that will actually happen, daylight-saving oddities included.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Spinner, Text } from '@/shared/ui';

import { describeCron } from '../model/cron';
import { absoluteTime } from '../model/time';
import type { SchedulePreview } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: {
            gap: theme.spacing.xs,
            padding: theme.spacing.md,
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
        },
        working: { flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center' },
        line: { flexDirection: 'row', gap: theme.spacing.sm },
    });

export interface PreviewState {
    data: SchedulePreview | null | undefined;
    isFetching: boolean;
}

function NextRuns({ preview }: { preview: PreviewState }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (preview.isFetching) {
        return (
            <View style={styles.working}>
                <Spinner />
                <Text variant="caption" tone="tertiary">
                    Working out the next runs…
                </Text>
            </View>
        );
    }
    if (preview.data && preview.data.valid) {
        return (
            <>
                {preview.data.next.map((iso) => (
                    <View key={iso} style={styles.line}>
                        <Icon name="ChevronRight" size={14} color={theme.colors.textMuted} />
                        <Text variant="caption" tone="secondary">
                            {absoluteTime(iso)}
                        </Text>
                    </View>
                ))}
            </>
        );
    }
    if (preview.data && !preview.data.valid) {
        return (
            <Text variant="caption" tone="error">
                {preview.data.error ?? 'The server could not read that schedule.'}
            </Text>
        );
    }
    return (
        <Text variant="caption" tone="tertiary">
            The next run times will be confirmed when you save.
        </Text>
    );
}

export function SchedulePreviewBox({ cron, tz, preview }: { cron: string; tz: string; preview: PreviewState }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View accessibilityLiveRegion="polite" style={styles.box}>
            <Text variant="caption" weight="medium">
                {describeCron(cron, tz)}
            </Text>
            <NextRuns preview={preview} />
        </View>
    );
}
