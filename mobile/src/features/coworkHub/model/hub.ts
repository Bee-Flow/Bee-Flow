/** What the Cowork hub puts first: runs that need you, and what is due next. */

import { statusToken, type AutomationRun } from '@/features/automations';
import type { AiTask, Reminder } from '@/features/tasks';

/**
 * How far back a stopped run still counts as something that needs you.
 *
 * A failure from eighteen days ago is history, not a task. Awaiting-approval
 * runs are exempt: those genuinely are waiting on a person however long they
 * have waited, and hiding one would lose the decision entirely.
 */
export const NEEDS_YOU_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Failed and awaiting-approval runs, newest first, at most four.
 *
 * `now` is the moment the runs were fetched (`dataUpdatedAt`), not the clock:
 * the age cutoff is a pure function of the data, and reading the clock during
 * render would age a run out on a re-render that fetched nothing.
 */
export function selectNeedsYou(runs: AutomationRun[], now: number): AutomationRun[] {
    const seen = new Set<string>();
    return runs
        .filter((run) => {
            const waiting = run.status === 'awaiting_approval';
            if (statusToken(run.status).tone !== 'error' && !waiting) return false;
            // Age out stale failures: four cards is the whole section, so a
            // fortnight-old failure occupies a slot something current cannot
            // have. A run with no start time cannot be aged out on evidence,
            // so it stays.
            const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
            if (!waiting && startedAt !== null && now - startedAt > NEEDS_YOU_WINDOW_MS) return false;
            // One card per automation. An automation that fails on a schedule
            // produces the SAME failure every run, so without this one broken
            // automation fills the section and hides everything else.
            if (seen.has(run.automationId)) return false;
            seen.add(run.automationId);
            return true;
        })
        .slice(0, 4);
}

export interface Upcoming {
    kind: 'task' | 'reminder';
    id: string;
    title: string;
    at: string;
    overdue: boolean;
}

/**
 * The next few things due, tasks and reminders merged.
 *
 * Merged rather than sectioned because the distinction is Bee Flow's, not the
 * user's: both are "a thing that happens at a time", and a phone's job at a
 * glance is to say which one is next.
 */
export function buildUpcoming(
    tasks: Pick<AiTask, 'id' | 'title' | 'nextRunAt' | 'isActive'>[],
    reminders: Pick<Reminder, 'id' | 'title' | 'remindAt'>[],
): Upcoming[] {
    const now = Date.now();
    const items: Upcoming[] = [];

    for (const task of tasks) {
        if (!task.isActive || !task.nextRunAt) continue;
        items.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            at: task.nextRunAt,
            overdue: new Date(task.nextRunAt).getTime() <= now,
        });
    }
    for (const reminder of reminders) {
        if (!reminder.remindAt) continue;
        items.push({
            kind: 'reminder',
            id: reminder.id,
            title: reminder.title,
            at: reminder.remindAt,
            overdue: new Date(reminder.remindAt).getTime() <= now,
        });
    }

    return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).slice(0, 5);
}
