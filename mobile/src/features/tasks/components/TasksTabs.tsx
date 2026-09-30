/**
 * The switch between tasks and reminders, with their counts, and — on the
 * tasks side — the organisation's cap once it is reached, so the limit is
 * met before the round trip rather than as a failed create.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

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
    const styles = useThemedStyles(makeStyles);
    return (
        <>
            <View style={styles.tabs}>
                <Segmented
                    accessibilityLabel="Tasks or reminders"
                    value={tab}
                    onChange={onChange}
                    options={[
                        { value: 'tasks', label: counted('Tasks', taskCount) },
                        { value: 'reminders', label: counted('Reminders', reminderCount) },
                    ]}
                />
            </View>

            {tab === 'tasks' && maxTasks !== null ? (
                <View style={styles.limit}>
                    <Banner tone="warning">
                        {`You have all ${maxTasks} tasks your organisation allows. Pause or delete one to make room.`}
                    </Banner>
                </View>
            ) : null}
        </>
    );
}
