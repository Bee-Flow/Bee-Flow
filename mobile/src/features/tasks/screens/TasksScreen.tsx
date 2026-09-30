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
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, ListSkeleton, Screen, ScreenHeader, useToast } from '@/shared/ui';

import { NewItemButton } from '../components/NewItemButton';
import { ReminderList } from '../components/ReminderList';
import { ReminderSheet } from '../components/ReminderSheet';
import { TaskDetailSheet } from '../components/TaskDetailSheet';
import { TaskList } from '../components/TaskList';
import { TaskSheet } from '../components/TaskSheet';
import { TasksTabs, type TasksTab } from '../components/TasksTabs';
import { useCompleteReminder, useRunTaskNow } from '../hooks/mutations';
import { useReminders, useTasks } from '../hooks/queries';
import type { AiTask, AiTaskList, Reminder } from '../model/types';

/** The one-tap writes on the lists, toasting the way this screen always has. */
function useListActions() {
    const { toast } = useToast();
    const onError = (error: Error) => toast(describeError(error).message, 'error');
    const complete = useCompleteReminder({ onSuccess: () => toast('Done', 'success'), onError });
    const runNow = useRunTaskNow({
        // The answer does NOT come back on this response — it is written to
        // notifications when the run finishes. Saying so is the difference
        // between a confirmation and a lie.
        onSuccess: () => toast('Started — the result lands in your notifications'),
        onError,
    });
    return { complete, runNow };
}

/** The organisation's cap, once this person has reached it; null until then. */
function capReached(list: AiTaskList | undefined): number | null {
    return list && list.tasks.length >= list.maxTasks ? list.maxTasks : null;
}

/** The current tab's list — or its skeleton, or why it could not load. */
function TasksBody({
    tab,
    tasks,
    reminders,
    open,
}: {
    tab: TasksTab;
    tasks: ReturnType<typeof useTasks>;
    reminders: ReturnType<typeof useReminders>;
    open: { task: (task: AiTask) => void; snooze: (r: Reminder) => void; newTask: () => void; newReminder: () => void };
}) {
    const { complete, runNow } = useListActions();
    const active = tab === 'tasks' ? tasks : reminders;
    const refresh = useUserRefresh(() => active.refetch());
    if (active.isLoading) return <ListSkeleton />;
    if (active.isError) return <ErrorState error={active.error} onRetry={() => void active.refetch()} />;
    if (tab === 'tasks') {
        return (
            <TaskList
                tasks={tasks.data?.tasks ?? []}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
                onOpen={open.task}
                onRun={(id) => runNow.mutate(id)}
                runningId={runNow.isPending ? (runNow.variables ?? null) : null}
                onCreate={open.newTask}
            />
        );
    }
    return (
        <ReminderList
            reminders={reminders.data ?? []}
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            onSnooze={open.snooze}
            onComplete={(id) => complete.mutate(id)}
            onCreate={open.newReminder}
        />
    );
}

export function TasksScreen() {
    const [tab, setTab] = useState<TasksTab>('tasks');
    const [taskSheet, setTaskSheet] = useState(false);
    const [reminderSheet, setReminderSheet] = useState(false);
    const [snoozing, setSnoozing] = useState<Reminder | null>(null);
    const [openTask, setOpenTask] = useState<AiTask | null>(null);

    const tasks = useTasks();
    const reminders = useReminders();
    const cap = capReached(tasks.data);
    const atLimit = cap !== null;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="Tasks and reminders" />

            <TasksTabs
                tab={tab}
                onChange={setTab}
                taskCount={tasks.data?.tasks.length}
                reminderCount={reminders.data?.length}
                maxTasks={cap}
            />

            <TasksBody
                tab={tab}
                tasks={tasks}
                reminders={reminders}
                open={{
                    task: setOpenTask,
                    snooze: setSnoozing,
                    newTask: () => setTaskSheet(true),
                    newReminder: () => setReminderSheet(true),
                }}
            />

            <NewItemButton
                label={tab === 'tasks' ? 'New task' : 'New reminder'}
                disabled={tab === 'tasks' && atLimit}
                onPress={() => (tab === 'tasks' ? setTaskSheet(true) : setReminderSheet(true))}
            />

            <TaskSheet visible={taskSheet} onClose={() => setTaskSheet(false)} />
            <ReminderSheet visible={reminderSheet} onClose={() => setReminderSheet(false)} />
            <ReminderSheet visible={Boolean(snoozing)} reschedule={snoozing} onClose={() => setSnoozing(null)} />
            <TaskDetailSheet task={openTask} onClose={() => setOpenTask(null)} />
        </Screen>
    );
}
