import { describe, expect, it } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { sprintPlanPoints, suggestSprintItems } from './sprintPlan';

const item = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: id, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: 'u1', completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

describe('suggestSprintItems', () => {
    it('fills in priority order, newest first inside one priority', () => {
        const items = [
            item('low', { priority: 'low', storyPoints: 2 }),
            item('urgent-old', { priority: 'urgent', storyPoints: 3, createdAt: '2026-09-01T00:00:00Z' }),
            item('normal', { priority: 'normal', storyPoints: 5 }),
            item('urgent-new', { priority: 'urgent', storyPoints: 3, createdAt: '2026-10-01T00:00:00Z' }),
        ];
        expect(suggestSprintItems(items, 20)).toEqual(['urgent-new', 'urgent-old', 'normal', 'low']);
    });

    it('stops at the capacity and skips an item that would overflow for a smaller one that fits', () => {
        const items = [
            item('big', { priority: 'urgent', storyPoints: 13 }),
            item('small', { priority: 'low', storyPoints: 2 }),
        ];
        expect(suggestSprintItems(items, 5)).toEqual(['small']);
    });

    it('never auto-fills unestimated items and ignores a missing or zero capacity', () => {
        const items = [item('unestimated'), item('points', { storyPoints: 3 })];
        expect(suggestSprintItems(items, 10)).toEqual(['points']);
        expect(suggestSprintItems(items, 0)).toEqual([]);
    });
});

describe('sprintPlanPoints', () => {
    it('sums the points of the picked items only', () => {
        const items = [item('a', { storyPoints: 3 }), item('b', { storyPoints: 5 }), item('c')];
        expect(sprintPlanPoints(items, new Set(['a', 'c']))).toBe(3);
    });
});
