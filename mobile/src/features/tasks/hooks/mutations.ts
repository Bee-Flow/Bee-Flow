/**
 * The task and reminder writes. Each one refreshes the list it changed, then
 * hands the screen its outcome.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    completeReminder,
    createReminder,
    createTask,
    deleteTask,
    runTaskNow,
    snoozeReminder,
    toggleTask,
    type CreateTaskInput,
} from '../api/endpoints';
import { taskKeys } from '../api/keys';
import type { Reminder } from '../model/types';

export interface Handlers<TData, TVars> {
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (error: Error) => void;
}

/** A mutation that refreshes one list on success, then calls the screen back. */
function useListMutation<TData, TVars>(
    list: readonly string[],
    mutationFn: (vars: TVars) => Promise<TData>,
    handlers: Handlers<TData, TVars>,
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn,
        onSuccess: (data: TData, vars: TVars) => {
            void queryClient.invalidateQueries({ queryKey: list });
            handlers.onSuccess?.(data, vars);
        },
        onError: handlers.onError,
    });
}

export function useCreateTask(handlers: Handlers<unknown, CreateTaskInput> = {}) {
    return useListMutation(taskKeys.tasks, createTask, handlers);
}

export function useRunTaskNow(handlers: Handlers<void, string> = {}) {
    return useListMutation(taskKeys.tasks, runTaskNow, handlers);
}

export function useToggleTask(handlers: Handlers<boolean | null, string> = {}) {
    return useListMutation(taskKeys.tasks, toggleTask, handlers);
}

export function useDeleteTask(handlers: Handlers<void, string> = {}) {
    return useListMutation(taskKeys.tasks, deleteTask, handlers);
}

export function useCompleteReminder(handlers: Handlers<void, string> = {}) {
    return useListMutation(taskKeys.reminders, completeReminder, handlers);
}

export interface ReminderDraft {
    title: string;
    message: string;
    remindAt: string;
    repeatInterval: string | null;
}

/**
 * Set a new reminder, or — given the one being moved — move it. Moving is the
 * only edit a phone needs, and it only ever changes the time.
 */
export function useSaveReminder(reschedule: Reminder | null | undefined, handlers: Handlers<void, ReminderDraft> = {}) {
    return useListMutation(
        taskKeys.reminders,
        async (draft: ReminderDraft) => {
            if (reschedule) {
                await snoozeReminder(reschedule.id, draft.remindAt);
                return;
            }
            await createReminder({
                title: draft.title.trim(),
                message: draft.message.trim() || undefined,
                remindAt: draft.remindAt,
                repeatInterval: draft.repeatInterval,
            });
        },
        handlers,
    );
}
