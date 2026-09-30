/** The AI tasks, each runnable in one tap. */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { EmptyState, InsetDivider } from '@/shared/ui';

import { TaskRow } from './TaskRow';
import type { AiTask } from '../model/types';

const styles = StyleSheet.create({ content: { flexGrow: 1, paddingBottom: 96 } });

export function TaskList({
    tasks,
    refreshing,
    onRefresh,
    onOpen,
    onRun,
    runningId,
    onCreate,
}: {
    tasks: AiTask[];
    refreshing: boolean;
    onRefresh: () => void;
    onOpen: (task: AiTask) => void;
    onRun: (id: string) => void;
    /** The task whose "Run now" is in flight, if any. */
    runningId: string | null;
    onCreate: () => void;
}) {
    const theme = useTheme();

    return (
        <FlatList
            data={tasks}
            keyExtractor={(task) => task.id}
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
                    icon="Cpu"
                    title="No tasks yet"
                    message="A task is a prompt Bee Flow runs on a schedule — a Monday news digest, a daily lead report. The answer arrives in your notifications."
                    actionLabel="New task"
                    onAction={onCreate}
                />
            }
            renderItem={({ item }) => (
                <TaskRow
                    task={item}
                    onPress={() => onOpen(item)}
                    onRun={() => onRun(item.id)}
                    running={runningId === item.id}
                />
            )}
            contentContainerStyle={styles.content}
        />
    );
}
