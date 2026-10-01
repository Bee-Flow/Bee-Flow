// Which backlog items a sprint of a given capacity should take. Pure.

import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { storyPoints } from './taskPlanning';
import { priorityRank } from './taskText';

/**
 * Fill a sprint in priority order (urgent → high → normal → low, newest first
 * inside one priority) up to `capacity` story points. Unestimated items are
 * never auto-filled: guessing a size is exactly what planning poker is for.
 * An item that would overflow the budget is skipped, not split; a smaller one
 * further down may still fit. Returns the picked task ids in fill order.
 */
export function suggestSprintItems(items: ProjectTask[], capacity: number): string[] {
    if (!(capacity > 0)) return [];
    const estimated = items
        .map(task => ({ task, points: storyPoints(task) }))
        .filter((e): e is { task: ProjectTask; points: number } => e.points !== null)
        .sort((a, b) => priorityRank(a.task.priority) - priorityRank(b.task.priority) || b.task.createdAt.localeCompare(a.task.createdAt));
    const picked: string[] = [];
    let total = 0;
    for (const { task, points } of estimated) {
        if (total + points > capacity) continue;
        total += points;
        picked.push(task.id);
    }
    return picked;
}

/** The running point total of the picked items. */
export function sprintPlanPoints(items: ProjectTask[], pickedIds: ReadonlySet<string>): number {
    return items.reduce((sum, task) => sum + (pickedIds.has(task.id) ? storyPoints(task) || 0 : 0), 0);
}
