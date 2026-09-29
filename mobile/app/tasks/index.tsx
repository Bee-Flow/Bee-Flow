/**
 * Tasks and reminders.
 *
 * These two are the most phone-shaped things Bee Flow has: a sentence and a
 * time. So the screen is built for speed rather than for completeness — one
 * tap completes a reminder, one tap runs a task, and creating either is two
 * fields and a preset. Everything that needs a form lives in a sheet, and
 * nothing needs a second screen.
 *
 * They share a screen because the distinction is the product's, not the
 * user's. A task runs a prompt and files the answer in notifications
 * (routes/aiTasks.js); a reminder just notifies you (routes/reminders.js).
 * Both answer "what have I got coming up?", which is why the tab hub merges
 * them and this screen keeps them one switch apart.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import {
    automateKeys,
    completeReminder,
    deleteTask,
    listReminders,
    listTasks,
    runTaskNow,
    toggleTask,
} from '../../src/features/automate/api';
import { ReminderSheet } from '../../src/features/automate/components/ReminderSheet';
import { TaskSheet } from '../../src/features/automate/components/TaskSheet';
import { absoluteTime, previewValue, statusLabel, statusToken } from '../../src/features/automate/format';
import type { AiTask, Reminder } from '../../src/features/automate/types';
import { useTranslation } from '../../src/i18n';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Segmented } from '../../src/ui/Segmented';
import { Sheet } from '../../src/ui/Sheet';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

type Tab = 'tasks' | 'reminders';

export default function TasksScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [tab, setTab] = useState<Tab>('tasks');
    const [taskSheet, setTaskSheet] = useState(false);
    const [reminderSheet, setReminderSheet] = useState(false);
    const [snoozing, setSnoozing] = useState<Reminder | null>(null);
    const [openTask, setOpenTask] = useState<AiTask | null>(null);

    const tasks = useQuery({
        queryKey: automateKeys.tasks,
        queryFn: ({ signal }) => listTasks(signal),
    });

    const reminders = useQuery({
        queryKey: automateKeys.reminders,
        queryFn: ({ signal }) => listReminders(false, signal),
    });

    const complete = useMutation({
        mutationFn: (id: string) => completeReminder(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.reminders });
            toast('Done', 'success');
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const runNow = useMutation({
        mutationFn: (id: string) => runTaskNow(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: automateKeys.tasks });
            // The answer does NOT come back on this response — it is written to
            // notifications when the run finishes. Saying so is the difference
            // between a confirmation and a lie.
            toast('Started — the result lands in your notifications');
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const active = tab === 'tasks' ? tasks : reminders;
    const atLimit = Boolean(tasks.data && tasks.data.tasks.length >= tasks.data.maxTasks);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="Tasks and reminders" />

            <View
                style={{
                    flexDirection: 'row',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.sm,
                }}
            >
                <Segmented
                    accessibilityLabel="Tasks or reminders"
                    value={tab}
                    onChange={setTab}
                    options={[
                        {
                            value: 'tasks',
                            label: `Tasks${tasks.data ? ` (${tasks.data.tasks.length})` : ''}`,
                        },
                        {
                            value: 'reminders',
                            label: `Reminders${reminders.data ? ` (${reminders.data.length})` : ''}`,
                        },
                    ]}
                />
            </View>

            {tab === 'tasks' && atLimit ? (
                <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                    <Banner tone="warning">
                        {`You have all ${tasks.data?.maxTasks} tasks your organisation allows. Pause or delete one to make room.`}
                    </Banner>
                </View>
            ) : null}

            {active.isLoading ? (
                <ListSkeleton />
            ) : active.isError ? (
                <ErrorState error={active.error} onRetry={() => void active.refetch()} />
            ) : tab === 'tasks' ? (
                <FlatList
                    data={tasks.data?.tasks ?? []}
                    keyExtractor={(task) => task.id}
                    ItemSeparatorComponent={() => <Divider inset={theme.spacing.lg} />}
                    refreshControl={
                        <RefreshControl
                            refreshing={tasks.isRefetching}
                            onRefresh={() => void tasks.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ListEmptyComponent={
                        <EmptyState
                            icon="cpu"
                            title="No tasks yet"
                            message="A task is a prompt Bee Flow runs on a schedule — a Monday news digest, a daily lead report. The answer arrives in your notifications."
                            actionLabel="New task"
                            onAction={() => setTaskSheet(true)}
                        />
                    }
                    renderItem={({ item }) => (
                        <TaskRow
                            task={item}
                            onPress={() => setOpenTask(item)}
                            onRun={() => runNow.mutate(item.id)}
                            running={runNow.isPending && runNow.variables === item.id}
                        />
                    )}
                    contentContainerStyle={{ flexGrow: 1, paddingBottom: 96 }}
                />
            ) : (
                <FlatList
                    data={reminders.data ?? []}
                    keyExtractor={(reminder) => reminder.id}
                    ItemSeparatorComponent={() => <Divider inset={theme.spacing.lg} />}
                    refreshControl={
                        <RefreshControl
                            refreshing={reminders.isRefetching}
                            onRefresh={() => void reminders.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    ListEmptyComponent={
                        <EmptyState
                            icon="bell"
                            title="Nothing to remember"
                            message="Set one and Bee Flow will notify you when the time comes — on every device you are signed in to."
                            actionLabel="New reminder"
                            onAction={() => setReminderSheet(true)}
                        />
                    }
                    renderItem={({ item }) => (
                        <ReminderRow
                            reminder={item}
                            onSnooze={() => setSnoozing(item)}
                            onComplete={() => complete.mutate(item.id)}
                        />
                    )}
                    contentContainerStyle={{ flexGrow: 1, paddingBottom: 96 }}
                />
            )}

            <Pressable
                onPress={() => (tab === 'tasks' ? setTaskSheet(true) : setReminderSheet(true))}
                disabled={tab === 'tasks' && atLimit}
                accessibilityRole="button"
                accessibilityLabel={tab === 'tasks' ? 'New task' : 'New reminder'}
                accessibilityState={{ disabled: tab === 'tasks' && atLimit }}
                style={{
                    position: 'absolute',
                    right: theme.spacing.lg,
                    bottom: theme.spacing.lg,
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: tab === 'tasks' && atLimit ? 0.4 : 1,
                    backgroundColor: theme.colors.accentPrimary,
                    ...theme.elevation.raised,
                }}
            >
                <Feather name="plus" size={24} color={theme.colors.accentPrimaryFg} />
            </Pressable>

            <TaskSheet visible={taskSheet} onClose={() => setTaskSheet(false)} />
            <ReminderSheet visible={reminderSheet} onClose={() => setReminderSheet(false)} />
            <ReminderSheet
                visible={Boolean(snoozing)}
                reschedule={snoozing}
                onClose={() => setSnoozing(null)}
            />
            <TaskDetailSheet task={openTask} onClose={() => setOpenTask(null)} />
        </Screen>
    );
}

function TaskRow({
    task,
    onPress,
    onRun,
    running,
}: {
    task: AiTask;
    onPress: () => void;
    onRun: () => void;
    running: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const token = task.lastStatus ? statusToken(task.lastStatus) : null;

    return (
        <ListRow
            title={task.title}
            subtitle={
                task.isActive
                    ? task.nextRunAt
                        ? `Next ${absoluteTime(task.nextRunAt).toLowerCase()}`
                        : 'Active'
                    : 'Paused'
            }
            wrapTitle
            leading={
                <Feather
                    name="cpu"
                    size={18}
                    color={task.isActive ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
                    {token && token.tone === 'error' ? (
                        <Badge label={statusLabel(t, token)} tone={token.tone} />
                    ) : null}
                    <IconButton
                        icon={<Feather name="play" size={16} color={theme.colors.textSecondary} />}
                        accessibilityLabel={`Run ${task.title} now`}
                        onPress={onRun}
                        disabled={running}
                    />
                </View>
            }
            onPress={onPress}
        />
    );
}

function ReminderRow({
    reminder,
    onSnooze,
    onComplete,
}: {
    reminder: Reminder;
    onSnooze: () => void;
    onComplete: () => void;
}) {
    const theme = useTheme();
    const due = isDue(reminder.remindAt);

    return (
        <ListRow
            title={reminder.title}
            subtitle={[
                absoluteTime(reminder.remindAt),
                reminder.repeatInterval ? `repeats ${reminder.repeatInterval}` : null,
                reminder.message || null,
            ]
                .filter(Boolean)
                .join(' · ')}
            wrapTitle
            leading={
                <Feather
                    name="bell"
                    size={18}
                    color={due ? theme.colors.warning : theme.colors.textMuted}
                />
            }
            trailing={
                <IconButton
                    icon={<Feather name="check" size={18} color={theme.colors.success} />}
                    accessibilityLabel={`Mark “${reminder.title}” done`}
                    onPress={onComplete}
                />
            }
            chevron={false}
            onPress={onSnooze}
        />
    );
}

/**
 * A task in full: what it asks, when it next runs, what it answered last time,
 * and the three things you can do to it. A sheet rather than a screen because
 * every one of those actions returns you straight to the list.
 */
function TaskDetailSheet({ task, onClose }: { task: AiTask | null; onClose: () => void }) {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const refresh = () => void queryClient.invalidateQueries({ queryKey: automateKeys.tasks });

    const toggle = useMutation({
        mutationFn: (id: string) => toggleTask(id),
        onSuccess: (isActive) => {
            refresh();
            toast(isActive ? 'Task resumed' : 'Task paused', 'success');
            onClose();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const remove = useMutation({
        mutationFn: (id: string) => deleteTask(id),
        onSuccess: () => {
            refresh();
            toast('Task deleted', 'success');
            onClose();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    const lastResult = previewValue(task?.lastResult, 800);

    return (
        <Sheet
            visible={Boolean(task)}
            onClose={onClose}
            title={task?.title ?? 'Task'}
            subtitle={
                task
                    ? task.isActive
                        ? `Next ${absoluteTime(task.nextRunAt).toLowerCase()}`
                        : 'Paused'
                    : undefined
            }
            footer={
                task ? (
                    <View style={{ gap: theme.spacing.sm }}>
                        <Button
                            label={task.isActive ? 'Pause this task' : 'Resume this task'}
                            variant="secondary"
                            fullWidth
                            loading={toggle.isPending}
                            onPress={() => toggle.mutate(task.id)}
                        />
                        <Button
                            label="Delete"
                            variant="destructive"
                            fullWidth
                            loading={remove.isPending}
                            onPress={() => remove.mutate(task.id)}
                        />
                    </View>
                ) : undefined
            }
        >
            {task ? (
                <>
                    <View style={{ gap: theme.spacing.xs }}>
                        <Text variant="label" tone="tertiary">
                            IT ASKS
                        </Text>
                        <Text variant="body" selectable>
                            {task.prompt}
                        </Text>
                    </View>

                    <View style={{ gap: theme.spacing.xs }}>
                        <Text variant="label" tone="tertiary">
                            SCHEDULE
                        </Text>
                        <Text variant="body">
                            {task.repeatInterval ? `Repeats ${task.repeatInterval}` : 'Runs once'}
                            {task.timezone ? ` · ${task.timezone}` : ''}
                        </Text>
                        {task.lastRunAt ? (
                            <Text variant="caption" tone="tertiary">
                                {`Last run ${relativeTime(task.lastRunAt, { suffix: true })}${
                                    task.runCount ? ` · ${task.runCount} runs in total` : ''
                                }`}
                            </Text>
                        ) : null}
                    </View>

                    {lastResult ? (
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="label" tone="tertiary">
                                LAST ANSWER
                            </Text>
                            <View
                                style={{
                                    padding: theme.spacing.md,
                                    borderRadius: theme.radii.md,
                                    backgroundColor: theme.colors.bgTertiary,
                                }}
                            >
                                <Text variant="body" tone="secondary" selectable>
                                    {lastResult}
                                </Text>
                            </View>
                        </View>
                    ) : null}
                </>
            ) : null}
        </Sheet>
    );
}

/**
 * Module-level so the clock is read outside the render pass — a component body
 * that calls Date.now() directly is impure by React's rules.
 */
function isDue(remindAt: string | null): boolean {
    if (!remindAt) return false;
    return new Date(remindAt).getTime() <= Date.now();
}
