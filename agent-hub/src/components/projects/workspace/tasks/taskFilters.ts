// Which tasks the list and the board show, and in what order. Pure.

import type { ProjectTask, TaskPriority } from '../../../../api/queries/projectTasks';
import { isOverdue, priorityRank } from './taskText';

export type TaskWho = 'all' | 'me' | 'unassigned' | string;
export type TaskSort = 'due' | 'priority' | 'newest';

export interface TaskFilters {
    search?: string;
    who: TaskWho;
    priority: 'all' | TaskPriority;
    /** A label the task must carry; '' for any. */
    label: string;
    overdueOnly: boolean;
}

export const NO_FILTERS: TaskFilters = { who: 'all', priority: 'all', label: '', overdueOnly: false };

export function hasFilters(f: TaskFilters): boolean {
    return !!f.search?.trim() || f.who !== 'all' || f.priority !== 'all' || !!f.label || f.overdueOnly;
}

function heldBy(task: ProjectTask, who: TaskWho, me: string | null): boolean {
    if (who === 'all') return true;
    if (who === 'me') return !!me && task.assigneeIds.includes(me);
    if (who === 'unassigned') return task.assigneeIds.length === 0;
    return task.assigneeIds.includes(who);
}

export function applyFilters(tasks: ProjectTask[], f: TaskFilters, me: string | null, today: string): ProjectTask[] {
    return tasks.filter(t => heldBy(t, f.who, me)
        && (f.priority === 'all' || t.priority === f.priority)
        && (!f.label || t.labels.includes(f.label))
        && (!f.overdueOnly || isOverdue(t.dueDate, t.status, today)));
}

/** Every label in use, alphabetically. */
export function allLabels(tasks: ProjectTask[]): string[] {
    return [...new Set(tasks.flatMap(t => t.labels))].sort((a, b) => a.localeCompare(b));
}

export function sortTasks(tasks: ProjectTask[], sort: TaskSort): ProjectTask[] {
    const list = [...tasks];
    if (sort === 'due') return list.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || priorityRank(a.priority) - priorityRank(b.priority));
    if (sort === 'priority') return list.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
