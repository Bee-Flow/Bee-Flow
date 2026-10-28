/**
 * The switch between tasks and reminders, with their counts, and — on the
 * tasks side — the organisation's cap once it is reached, so the limit is
 * met before the round trip rather than as a failed create.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Segmented } from '@/shared/ui';

export type TasksTab = 'tasks' | 'reminders';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        tabs: {
            flexDirection: 'row',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: theme.spacing.sm,
        },
        limit: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

const counted = (word: string, count: number | undefined) => `${word}${count === undefined ? '' : ` (${count})`}`;

export function TasksTabs({
    tab,
    onChange,
    taskCount,
    reminderCount,
    maxTasks,
}: {
    tab: TasksTab;
    onChange: (tab: TasksTab) => void;
    taskCount: number | undefined;
    reminderCount: number | undefined;
    /** Set once the cap is reached; shown on the tasks side only. */
    maxTasks: number | null;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <View style={styles.tabs}>
                <Segmented
                    accessibilityLabel={t('mobile.tasks.tabs_label', 'Tasks or reminders')}
                    value={tab}
                    onChange={onChange}
                    options={[
                        { value: 'tasks', label: counted(t('tasks.title', 'Tasks'), taskCount) },
                        { value: 'reminders', label: counted(t('mobile.tasks.reminders', 'Reminders'), reminderCount) },
                    ]}
                />
            </View>

            {tab === 'tasks' && maxTasks !== null ? (
                <View style={styles.limit}>
                    <Banner tone="warning">
                        {t('mobile.tasks.limit', 'You have all {max} tasks your organisation allows. Pause or delete one to make room.', { max: maxTasks })}
                    </Banner>
                </View>
            ) : null}
        </>
    );
}
