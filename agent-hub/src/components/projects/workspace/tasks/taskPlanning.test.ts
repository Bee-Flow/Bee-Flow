import { describe, expect, it } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import { addDays, dependencyEdges, buildWorkTree, monday, moveDates, rangePlacement, rollup, taskRange, timelineRelations, TIMELINE_ROW } from './taskPlanning';

describe('Gantt calendar math', () => {
    it('keeps calendar days across DST, leap days and year boundaries', () => {
        expect(addDays('2026-10-24', 3)).toBe('2026-10-27');
        expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(monday('2026-10-04')).toBe('2026-09-28');
    });
    it('moves both endpoints together and clamps resizing at a single day', () => {
        const task = { startDate: '2026-10-02', dueDate: '2026-10-06' };
        expect(moveDates(task, 'move', -3)).toEqual({ startDate: '2026-09-29', dueDate: '2026-10-03' });
        expect(moveDates(task, 'start', 8)).toEqual({ startDate: '2026-10-06', dueDate: '2026-10-06' });
        expect(moveDates(task, 'end', -8)).toEqual({ startDate: '2026-10-02', dueDate: '2026-10-02' });
    });
    it('handles legacy deadline-only tasks and unscheduled tasks', () => {
        expect(taskRange({ dueDate: '2026-10-02' })).toEqual({ start: '2026-10-02', end: '2026-10-02' });
        expect(taskRange({ startDate: '2026-10-02', dueDate: null })).toEqual({ start: '2026-10-02', end: '2026-10-02' });
        expect(moveDates({ dueDate: null }, 'move', 1)).toBeNull();
    });
    it('clips spanning tasks without inventing resize endpoints and excludes out-of-view ranges', () => {
        expect(rangePlacement('2026-09-20', '2026-11-01', '2026-10-01', 14)).toEqual({ left: 0, width: 14, clippedStart: true, clippedEnd: true });
        expect(rangePlacement('2026-10-14', '2026-10-14', '2026-10-01', 14)?.width).toBe(1);
        expect(rangePlacement('2026-10-15', '2026-10-16', '2026-10-01', 14)).toBeNull();
    });
});

const work = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: id, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: 'u1', completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

describe('buildWorkTree', () => {
    it('nests epic → story → task and keeps parentless items as roots', () => {
        const epic = work('e', { itemType: 'epic' });
        const story = work('s', { itemType: 'story', parentTaskId: 'e' });
        const leaf = work('t', { itemType: 'task', parentTaskId: 's' });
        const plain = work('p');
        const { roots, ungrouped } = buildWorkTree([leaf, plain, story, epic]);
        expect(ungrouped).toEqual([]);
        expect(roots.map(n => n.task.id)).toEqual(['p', 'e']);
        expect(roots[1].children[0].task.id).toBe('s');
        expect(roots[1].children[0].children[0].task.id).toBe('t');
    });

    it('puts items whose parent is not in the list under ungrouped instead of dropping them', () => {
        const orphan = work('o', { parentTaskId: 'gone' });
        const { roots, ungrouped } = buildWorkTree([orphan, work('a')]);
        expect(roots.map(n => n.task.id)).toEqual(['a']);
        expect(ungrouped.map(t => t.id)).toEqual(['o']);
    });

    it('lifts the members of a parent cycle to the roots rather than hiding them', () => {
        const a = work('a', { parentTaskId: 'b' });
        const b = work('b', { parentTaskId: 'a' });
        const { roots, ungrouped } = buildWorkTree([a, b]);
        expect(ungrouped).toEqual([]);
        expect(roots.map(n => n.task.id).sort()).toEqual(['a', 'b']);
    });
});

describe('rollup', () => {
    it('counts a node and everything under it: items done and points', () => {
        const tree = buildWorkTree([
            work('e', { itemType: 'epic', storyPoints: 8 }),
            work('s', { itemType: 'story', parentTaskId: 'e', storyPoints: 5, status: 'done' }),
            work('t', { itemType: 'task', parentTaskId: 's', storyPoints: 3 }),
        ]);
        expect(rollup(tree.roots[0])).toEqual({ total: 3, done: 1, points: 16 });
    });

    it('reads points from the legacy bf:points label when the field is absent', () => {
        const tree = buildWorkTree([work('e', { labels: ['bf:points:13'] })]);
        expect(rollup(tree.roots[0]).points).toBe(13);
    });
});


// Rows are TIMELINE_ROW (40px) tall, so a bar's middle sits at y = row * 40 + 20.
describe('timeline dependencies', () => {
    it('lays rows out at the 40px row height', () => expect(TIMELINE_ROW).toBe(40));

    it('routes overlapping dependencies in either row direction around the endpoints', () => {
        const a = work('a', { startDate: '2026-10-01', dueDate: '2026-10-06' });
        const b = work('b', { startDate: '2026-10-02', dueDate: '2026-10-07', links: [{ kind: 'task', id: 'a', relation: 'depends_on' }] });
        const down = dependencyEdges([a, b], '2026-10-01', 14, 58)[0];
        const up = dependencyEdges([b, a], '2026-10-01', 14, 58)[0];
        expect(down.path).toMatch(/^M 346 20 .* L 60 60$/);
        expect(up.path).toMatch(/^M 346 60 .* L 60 20$/);
        expect(down.source).toEqual({ x: 346, y: 20 });
        expect(up.source).toEqual({ x: 346, y: 60 });
        expect(down.path).toContain('Q 356 37');
        expect(up.path).toContain('Q 356 43');
        expect(down.conflict).toBe(true);
        expect(up.conflict).toBe(true);
    });

    it('avoids an unrelated bar between dependency endpoints', () => {
        const a = work('a', { startDate: '2026-10-01', dueDate: '2026-10-02' });
        const middle = work('middle', { startDate: '2026-10-02', dueDate: '2026-10-09' });
        const b = work('b', { startDate: '2026-10-07', dueDate: '2026-10-08', links: [{ kind: 'task', id: 'a', relation: 'depends_on' }] });
        const [edge] = dependencyEdges([a, middle, b], '2026-10-01', 14, 58);
        // x=52 is left of the intervening bar (x=60..520), while the
        // direct midpoint (x=232) would have crossed it.
        expect(edge.path).toContain('L 52 78');
        expect(edge.path).toMatch(/^M 114 20 .* L 350 100$/);
        expect(edge.conflict).toBe(false);
    });

    it('clips spanning endpoints and draws duplicate links only once', () => {
        const a = work('a', { startDate: '2026-09-01', dueDate: '2026-11-01' });
        const b = work('b', { startDate: '2026-10-01', dueDate: '2026-10-02', links: [{ kind: 'task', id: 'a', relation: 'depends_on' }, { kind: 'task', id: 'a', relation: 'depends_on' }] });
        const edges = dependencyEdges([a, b], '2026-10-01', 14, 58);
        expect(edges).toHaveLength(1);
        expect(edges[0].path).toMatch(/^M 810 20 .* L 2 60$/);
        expect(edges[0].path).not.toMatch(/NaN|undefined/);
    });

    it('draws only explicit dependencies from predecessor to successor, flags overlap and clips endpoints', () => {
        const a = work('a', { startDate: '2026-10-01', dueDate: '2026-10-03' });
        const b = work('b', { startDate: '2026-10-05', dueDate: '2026-10-07', links: [{ kind: 'task', id: 'a', relation: 'depends_on' }, { kind: 'task', id: 'missing', relation: 'depends_on' }] });
        const related = work('c', { startDate: '2026-10-02', dueDate: '2026-10-04', links: [{ kind: 'task', id: 'a' }] });
        const edges = dependencyEdges([a, b, related], '2026-10-01', 14, 58);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ id: 'a:b', predecessor: a, successor: b, conflict: false });
        expect(edges[0].path).toContain('M 172 20');
        expect(dependencyEdges([a, { ...b, startDate: '2026-10-02' }], '2026-10-01', 14, 58)[0].conflict).toBe(true);
        expect(dependencyEdges([a, b], '2026-10-04', 14, 58)).toEqual([]);
        expect(dependencyEdges([b], '2026-10-01', 14, 58)).toEqual([]);
        expect(dependencyEdges([a, { ...b, dueDate: null, startDate: null }], '2026-10-01', 14, 58)).toEqual([]);
    });
});

describe('timeline relationships', () => {
    const planned = (id: string, extra: Partial<ProjectTask> = {}) => work(id, { startDate: '2026-10-01', dueDate: '2026-10-05', ...extra });

    it('draws the epic → story → task hierarchy alongside explicit dependencies', () => {
        const epic = planned('epic', { itemType: 'epic' });
        const story = planned('story', { itemType: 'user-story', parentTaskId: 'epic', links: [{ kind: 'task', id: 'task', relation: 'depends_on' }] });
        const child = planned('task', { parentTaskId: 'story' });
        const edges = timelineRelations([epic, story, child], '2026-10-01', 14, 58);
        expect(edges.map(edge => [edge.id, edge.relation, edge.conflict])).toEqual([
            ['epic:story', 'parent_child', false],
            ['task:story', 'depends_on', true],
            ['story:task', 'parent_child', false],
        ]);
        expect(edges[0].source).toEqual({ x: 288, y: 20 });
        expect(edges[0].path).toMatch(/^M 288 20 .* L 2 60$/);
    });

    it('draws ordinary related task links once without treating overlapping dates as a dependency', () => {
        const a = planned('a', { links: [{ kind: 'task', id: 'b' }, { kind: 'task', id: 'b' }] });
        const b = planned('b', { links: [{ kind: 'task', id: 'a' }] });
        const edges = timelineRelations([a, b], '2026-10-01', 14, 58);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ relation: 'related', conflict: false });
        expect(edges[0].path).toMatch(/^M 288 20 .* L 2 60$/);
        expect(dependencyEdges([a, b], '2026-10-01', 14, 58)).toEqual([]);
    });

    it.each(['epic', 'task'] as const)('routes a Related link stored on the %s from the epic end to the task start', holder => {
        const link = { kind: 'task' as const, id: holder === 'epic' ? 'task' : 'epic' };
        const epic = planned('epic', { itemType: 'epic', links: holder === 'epic' ? [link] : [] });
        const child = planned('task', { links: holder === 'task' ? [link] : [] });
        const [edge] = timelineRelations([child, epic], '2026-10-01', 14, 58);
        expect(edge).toMatchObject({ id: 'epic:task', relation: 'related', source: { x: 288, y: 60 }, target: { x: 2, y: 20 }, conflict: false });
        expect(edge.path).toMatch(/^M 288 60 .* L 2 20$/);
    });

    it('connects a parent end to each child start, including a parent below its child', () => {
        const epic = planned('epic', { itemType: 'epic', dueDate: '2026-10-02' });
        const story = planned('story', { parentTaskId: 'epic', startDate: '2026-10-05' });
        const second = planned('second', { parentTaskId: 'epic', startDate: '2026-10-06', dueDate: '2026-10-07' });
        const edges = timelineRelations([epic, story, second], '2026-10-01', 14, 58);
        expect(edges.map(edge => edge.source)).toEqual([{ x: 114, y: 20 }, { x: 114, y: 20 }]);
        expect(edges[0].path).toMatch(/^M 114 20 .* L 234 60$/);
        expect(edges[1].path).toMatch(/^M 114 20 .* L 292 100$/);
        const [up] = timelineRelations([story, epic], '2026-10-01', 14, 58);
        expect(up.path).toMatch(/^M 114 60 .* L 234 20$/);
        expect(edges.every(edge => !edge.conflict)).toBe(true);
    });

    it('does not invent relationships from dates, and excludes unavailable endpoints', () => {
        const a = planned('a');
        const b = planned('b', { parentTaskId: 'missing', links: [{ kind: 'task', id: 'unscheduled' }, { kind: 'task', id: 'outside', relation: 'depends_on' }, { kind: 'task', id: 'b' }, { kind: 'document', id: 'a' }] });
        const unscheduled = work('unscheduled');
        const outside = work('outside', { startDate: '2026-09-01', dueDate: '2026-09-02' });
        expect(timelineRelations([a, b, unscheduled, outside], '2026-10-01', 14, 58)).toEqual([]);
        expect(timelineRelations([planned('child', { parentTaskId: 'a' })], '2026-10-01', 14, 58)).toEqual([]);
    });
});
