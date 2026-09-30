/** Whether a schedule is on, how it repeats, and when it runs next. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { describeMoment, repeatLabel } from '../model/schedule';
import type { CoworkSchedule } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { gap: theme.spacing.sm },
        badges: { flexDirection: 'row', gap: theme.spacing.sm },
    });

function nextLine(schedule: CoworkSchedule, t: TranslateFn): string {
    if (schedule.isActive && schedule.nextRunAt) {
        return t('mobile.cowork.next_when', 'Next: {when}', { when: describeMoment(schedule.nextRunAt) });
    }
    return schedule.isActive ? 'No next run scheduled' : 'Paused — it will not run until you resume it.';
}

export function ScheduleSummary({ schedule }: { schedule: CoworkSchedule }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.root}>
            <View style={styles.badges}>
                <Badge
                    label={schedule.isActive ? 'Scheduled' : 'Paused'}
                    tone={schedule.isActive ? 'success' : 'neutral'}
                />
                {schedule.repeatInterval ? (
                    <Badge label={repeatLabel(schedule.repeatInterval)} tone="neutral" />
                ) : null}
            </View>
            <Text variant="caption" tone="tertiary">
                {nextLine(schedule, t)}
            </Text>
        </View>
    );
}
