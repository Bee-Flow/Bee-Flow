/** The open reminders: tap to move one, tick to complete it. */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { EmptyState, InsetDivider } from '@/shared/ui';

import { ReminderRow } from './ReminderRow';
import type { Reminder } from '../model/types';

const styles = StyleSheet.create({ content: { flexGrow: 1, paddingBottom: 96 } });

export function ReminderList({
    reminders,
    refreshing,
    onRefresh,
    onSnooze,
    onComplete,
    onCreate,
}: {
    reminders: Reminder[];
    refreshing: boolean;
    onRefresh: () => void;
    onSnooze: (reminder: Reminder) => void;
    onComplete: (id: string) => void;
    onCreate: () => void;
}) {
    const theme = useTheme();

    return (
        <FlatList
            data={reminders}
            keyExtractor={(reminder) => reminder.id}
            ItemSeparatorComponent={InsetDivider}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListEmptyComponent={
                <EmptyState
                    icon="Bell"
                    title="Nothing to remember"
                    message="Set one and Bee Flow will notify you when the time comes — on every device you are signed in to."
                    actionLabel="New reminder"
                    onAction={onCreate}
                />
            }
            renderItem={({ item }) => (
                <ReminderRow
                    reminder={item}
                    onSnooze={() => onSnooze(item)}
                    onComplete={() => onComplete(item.id)}
                />
            )}
            contentContainerStyle={styles.content}
        />
    );
}
