// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { allLabels, applyFilters, hasFilters, NO_FILTERS, sortTasks } from './taskFilters';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: id, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 0, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: 'u', completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

const TASKS = [
    task('a', { assigneeIds: ['me'], priority: 'high', labels: ['legal'], dueDate: '2026-10-10' }),
    task('b', { assigneeIds: ['ben'], priority: 'low', labels: ['launch', 'legal'], dueDate: '2026-10-20' }),
    task('c', { priority: 'urgent', createdAt: '2026-10-03T00:00:00Z' }),
    task('d', { assigneeIds: ['me'], status: 'done', dueDate: '2026-10-01' }),
];
const ids = (list: ProjectTask[]) => list.map(t => t.id);

describe('task filters', () => {
    it('narrows by person, priority, label and lateness', () => {
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, who: 'me' }, 'me', '2026-10-15'))).toEqual(['a', 'd']);
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, who: 'unassigned' }, 'me', '2026-10-15'))).toEqual(['c']);
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, who: 'ben' }, 'me', '2026-10-15'))).toEqual(['b']);
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, priority: 'urgent' }, 'me', '2026-10-15'))).toEqual(['c']);
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, label: 'legal' }, 'me', '2026-10-15'))).toEqual(['a', 'b']);
        // Overdue means late and not done: d is late but finished.
        expect(ids(applyFilters(TASKS, { ...NO_FILTERS, overdueOnly: true }, 'me', '2026-10-15'))).toEqual(['a']);
    });

    it('knows when a filter is on, and lists each label once', () => {
        expect(hasFilters(NO_FILTERS)).toBe(false);
        expect(hasFilters({ ...NO_FILTERS, label: 'x' })).toBe(true);
        expect(allLabels(TASKS)).toEqual(['launch', 'legal']);
    });

    it('sorts by due date (none last), by priority, and newest first', () => {
        expect(ids(sortTasks(TASKS, 'due'))).toEqual(['d', 'a', 'b', 'c']);
        expect(ids(sortTasks(TASKS, 'priority'))).toEqual(['c', 'a', 'd', 'b']);
        expect(ids(sortTasks(TASKS, 'newest'))[0]).toBe('c');
    });
});
