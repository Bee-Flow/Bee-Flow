/**
 * The scheduled-task and reminder endpoints. Paths are the full client-visible
 * ones: tasks are Cowork schedules (/api/cowork → routes/cowork.js; the old
 * /api/ai-tasks is gone and its rows moved there with their ids), reminders
 * are /api/reminders → routes/reminders.js. Neither is licence-gated.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import { readReminder, readReminderRows, readTask } from './readers';
import type { AiTask, AiTaskList, Reminder, RepeatInterval } from '../model/types';

const taskPath = (id: string) => `/api/cowork/${encodeURIComponent(id)}`;
const reminderPath = (id: string) => `/api/reminders/${encodeURIComponent(id)}`;

// ── Scheduled tasks (Cowork) ────────────────────────────────────────

/** Every Cowork schedule of the caller, as the task list this feature renders. */
export async function listTasks(signal?: AbortSignal): Promise<AiTaskList> {
    const res = await api.get<unknown>('/api/cowork', { signal });
    return {
        tasks: withId(field.list(readTask)(pick(res, 'schedules'))),
        maxTasks: field.num(10)(pick(res, 'maxSchedules')),
    };
}

export interface CreateTaskInput {
    title: string;
    prompt: string;
    /** REQUIRED by the server — a task with no first run time is a 400. */
    nextRunAt: string;
    repeatInterval?: RepeatInterval | null;
    modelTier?: string;
    timezone?: string;
    /** Also fire it immediately instead of waiting for the 60s scheduler tick. */
    startNow?: boolean;
}

export async function createTask(input: CreateTaskInput): Promise<AiTask | null> {
    return nullable(readTask)(await api.post<unknown>('/api/cowork', input, { retry: false }));
}

export async function toggleTask(id: string): Promise<boolean | null> {
    const res = await api.post<unknown>(`${taskPath(id)}/toggle`, {}, { retry: false });
    const isActive = pick(res, 'isActive');
    return typeof isActive === 'boolean' ? isActive : null;
}

/**
 * Fire a task now. Answers immediately and runs in the background — the result
 * lands in notifications, NOT in this response, so the confirmation has to say
 * where to look.
 */
export async function runTaskNow(id: string): Promise<void> {
    await api.post(`${taskPath(id)}/run-now`, {}, { retry: false });
}

export async function deleteTask(id: string): Promise<void> {
    await api.delete(taskPath(id));
}

// ── Reminders ───────────────────────────────────────────────────────

/** Answers a BARE array, unlike every other list endpoint on this tab. */
export async function listReminders(
    includeCompleted = false,
    signal?: AbortSignal,
): Promise<Reminder[]> {
    return withId(
        readReminderRows(
            await api.get<unknown>('/api/reminders', {
                signal,
                query: includeCompleted ? { completed: 'true' } : undefined,
            }),
        ),
    );
}

export async function createReminder(input: {
    title: string;
    message?: string;
    remindAt: string;
    repeatInterval?: string | null;
}): Promise<Reminder | null> {
    return nullable(readReminder)(await api.post<unknown>('/api/reminders', input, { retry: false }));
}

export async function completeReminder(id: string): Promise<void> {
    await api.post(`${reminderPath(id)}/complete`, {}, { retry: false });
}

/**
 * Snooze.
 *
 * There is no snooze endpoint — the server models a reminder as a title and a
 * time, so snoozing IS moving the time. Naming it honestly here keeps the
 * screens from inventing a concept the backend does not have.
 */
export async function snoozeReminder(id: string, remindAt: string): Promise<void> {
    await api.put(reminderPath(id), { remindAt }, { retry: false });
}

