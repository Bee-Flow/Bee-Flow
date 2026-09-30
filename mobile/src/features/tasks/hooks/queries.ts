/** The AI task and reminder lists. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { listReminders, listTasks } from '../api/endpoints';
import { taskKeys } from '../api/keys';

export function useTasks() {
    return useQuery({
        queryKey: taskKeys.tasks,
        queryFn: ({ signal }) => listTasks(signal),
    });
}

/** Open reminders only; completed ones are history the phone never lists. */
export function useReminders() {
    return useQuery({
        queryKey: taskKeys.reminders,
        queryFn: ({ signal }) => listReminders(false, signal),
    });
}
