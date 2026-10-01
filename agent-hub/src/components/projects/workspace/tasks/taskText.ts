import type { ChecklistItem, TaskPriority, TaskStatus } from '../../../../api/queries/projectTasks';
import type { TranslateFn } from '../../../../hooks/useTranslation';

export function statusLabel(t: TranslateFn, status: TaskStatus): string {
    if (status === 'doing') return t('project_tasks.status_doing', 'In progress');
    if (status === 'done') return t('project_tasks.status_done', 'Done');
    return t('project_tasks.status_todo', 'To do');
}

/** Today as `YYYY-MM-DD` in the reader's own calendar. */
export function todayKey(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Due before today and not done. */
export function isOverdue(dueDate: string | null, status: TaskStatus, today = todayKey()): boolean {
    return !!dueDate && status !== 'done' && dueDate < today;
}

/** Due today or within the next `days` days, and not done: the quiet warning before "overdue". */
export function isDueSoon(dueDate: string | null, status: TaskStatus, today = todayKey(), days = 2): boolean {
    if (!dueDate || status === 'done' || dueDate < today) return false;
    const limit = new Date(`${today}T00:00:00`);
    if (Number.isNaN(limit.getTime())) return false;
    limit.setDate(limit.getDate() + days);
    return dueDate <= todayKey(limit);
}

/** How urgent a due date reads: 'overdue', 'soon' or null for a calm date (or none). */
export function dueState(dueDate: string | null, status: TaskStatus, today = todayKey()): 'overdue' | 'soon' | null {
    if (isOverdue(dueDate, status, today)) return 'overdue';
    return isDueSoon(dueDate, status, today) ? 'soon' : null;
}

export function formatDue(dueDate: string, locale: string): string {
    const d = new Date(`${dueDate}T00:00:00`);
    return Number.isNaN(d.getTime()) ? dueDate : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export function priorityLabel(t: TranslateFn, priority: TaskPriority): string {
    if (priority === 'low') return t('project_tasks.priority_low', 'Low');
    if (priority === 'high') return t('project_tasks.priority_high', 'High');
    if (priority === 'urgent') return t('project_tasks.priority_urgent', 'Urgent');
    return t('project_tasks.priority_normal', 'Normal');
}

/** A colour token for a priority, or null for the ordinary ones that need no mark. */
export function priorityTone(priority: TaskPriority): string | null {
    if (priority === 'urgent') return 'var(--error-ink)';
    if (priority === 'high') return 'var(--warning, var(--accent-primary))';
    return null;
}

/** `2/5`: how much of a checklist is done, or null without one (also for a task that has no checklist field). */
export function checklistProgress(items: ChecklistItem[] | null | undefined): { done: number; total: number } | null {
    return items?.length ? { done: items.filter(i => i.done).length, total: items.length } : null;
}

const RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export const priorityRank = (p: TaskPriority) => RANK[p];
