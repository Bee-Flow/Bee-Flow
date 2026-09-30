/**
 * The AI task and reminder endpoints. Paths are the full client-visible ones:
 * /api/ai-tasks → routes/aiTasks.js, /api/reminders → routes/reminders.js.
 * Neither is licence-gated.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { listSchedules } from '@/features/cowork';
import { withId } from '@/shared/lib/withId';

import { readReminder, readReminderRows, readTask } from './readers';
import type { AiTask, AiTaskList, Reminder, RepeatInterval } from '../model/types';

const taskPath = (id: string) => `/api/ai-tasks/${encodeURIComponent(id)}`;
const reminderPath = (id: string) => `/api/reminders/${encodeURIComponent(id)}`;

// ── AI tasks ────────────────────────────────────────────────────────

/**
 * AI tasks, minus the copies left behind by the move to Cowork.
 *
 * server/migrations/prompt-tasks-to-cowork-2026-08 copied every plain
 * (agent-less) task into cowork_schedules UNDER THE SAME ID and left the
 * original here, paused, as a rollback copy. Listing it showed a paused
 * duplicate of something already running under Cowork — with a toggle that
 * would run it twice. The web drops every plain row (usePromptTasks.ts keeps
 * only `agentId`); the phone cannot, because its New task sheet still creates
 * plain tasks, and the migration runs once (the boot/bootMigrations.js
 * ledger): a task made since has no twin and is the only copy there is. So the
 * test is the twin itself — a plain task whose id is also a Cowork schedule's.
 *
 * Only a PAUSED twin is dropped. One that was switched back on runs in both
 * loops (two LLM calls, two notifications, per the migration's header), and
 * this list is the only place on the phone that can pause it again.
 *
 * Cowork can be withheld by a licence, or fail; then nothing is dropped,
 * which is what this list showed before.
 */
export async function listTasks(signal?: AbortSignal): Promise<AiTaskList> {
    const [res, moved] = await Promise.all([
        api.get<unknown>('/api/ai-tasks', { signal }),
        listSchedules(signal).then(
            (schedules) => new Set(schedules.map((s) => s.id)),
            () => new Set<string>(),
        ),
    ]);
    const tasks = withId(field.list(readTask)(pick(res, 'tasks')));
    return {
        tasks: tasks.filter((task) => Boolean(task.agentId) || task.isActive || !moved.has(task.id)),
        maxTasks: field.num(10)(pick(res, 'maxTasks')),
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
    return nullable(readTask)(await api.post<unknown>('/api/ai-tasks', input, { retry: false }));
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

