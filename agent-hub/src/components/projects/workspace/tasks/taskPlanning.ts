import type { ProjectTask } from '../../../../api/queries/projectTasks';

// Planning metadata lives in reserved task labels so it follows the task through
// the existing project API and remains compatible with older Bee Flow servers.
const META = 'bf:';
export type WorkItemType = 'epic' | 'story' | 'user-story' | 'task';
export const WORK_ITEM_TYPES: WorkItemType[] = ['epic', 'story', 'user-story', 'task'];
export function canContainWorkItem(parent: WorkItemType, child: WorkItemType): boolean {
    return parent === 'epic' ? ['story', 'user-story'].includes(child) : ['story', 'user-story'].includes(parent) && ['user-story', 'task'].includes(child);
}
/** The type "Add child" presets for a parent of this type; null for a leaf (a task holds nothing). */
export function childWorkItemType(parent: WorkItemType): WorkItemType | null {
    if (parent === 'epic') return 'story';
    if (parent === 'story' || parent === 'user-story') return 'task';
    return null;
}
export function workItemType(task: Pick<ProjectTask, 'labels'> & Partial<Pick<ProjectTask, 'itemType'>>): WorkItemType {
    if (task.itemType && WORK_ITEM_TYPES.includes(task.itemType)) return task.itemType;
    const value = task.labels.find(label => label.startsWith(`${META}type:`))?.slice(8);
    return WORK_ITEM_TYPES.includes(value as WorkItemType) ? value as WorkItemType : 'task';
}
export function storyPoints(task: Pick<ProjectTask, 'labels'> & Partial<Pick<ProjectTask, 'storyPoints'>>): number | null {
    if (typeof task.storyPoints === 'number' && task.storyPoints > 0) return task.storyPoints;
    const value = Number(task.labels.find(label => label.startsWith(`${META}points:`))?.slice(10));
    return Number.isFinite(value) && value > 0 ? value : null;
}
export function sprintName(task: Pick<ProjectTask, 'labels'>): string | null {
    return task.labels.find(label => label.startsWith(`${META}sprint:`))?.slice(10) || null;
}
export function withPlanningMeta(labels: string[], patch: { sprint?: string | null; sprintStart?: string; sprintEnd?: string }) {
    const next = labels.filter(label => !label.startsWith(META));
    const currentSprint = labels.find(label => label.startsWith(`${META}sprint:`));
    const sprint = patch.sprint === undefined ? currentSprint?.slice(10) : patch.sprint;
    if (sprint) next.push(`${META}sprint:${sprint}`);
    const currentStart = labels.find(label => label.startsWith(`${META}sprint-start:`))?.slice(16);
    const currentEnd = labels.find(label => label.startsWith(`${META}sprint-end:`))?.slice(14);
    const start = patch.sprint === null ? undefined : patch.sprintStart ?? currentStart;
    const end = patch.sprint === null ? undefined : patch.sprintEnd ?? currentEnd;
    if (sprint && start) next.push(`${META}sprint-start:${start}`);
    if (sprint && end) next.push(`${META}sprint-end:${end}`);
    return next;
}
export function visibleLabels(labels: string[]) { return labels.filter(label => !label.startsWith(META)); }
export function retainSprintLabels(oldLabels: string[], nextLabels: string[]) {
    return [...nextLabels, ...oldLabels.filter(label => label.startsWith(`${META}sprint:`) || label.startsWith(`${META}sprint-start:`) || label.startsWith(`${META}sprint-end:`))];
}

// ── Hierarchy (epic → story → task) ─────────────────────────────────────────

export interface WorkNode { task: ProjectTask; children: WorkNode[] }
export interface WorkRollup { total: number; done: number; points: number }

/**
 * The work items as a tree. A task hangs under its `parentTaskId` when the
 * parent is in the list; roots are the items without a parent. Items that
 * name a parent the list does not hold (filtered out, or from before the
 * hierarchy) come back in `ungrouped` instead of disappearing, and a parent
 * cycle (only possible from legacy data) is broken by treating its member as
 * a root. Input order is kept within every level.
 */
export function buildWorkTree(tasks: ProjectTask[]): { roots: WorkNode[]; ungrouped: ProjectTask[] } {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const nodes = new Map<string, WorkNode>(tasks.map(task => [task.id, { task, children: [] }]));
    const roots: WorkNode[] = [];
    const ungrouped: ProjectTask[] = [];
    const cyclic = (task: ProjectTask): boolean => {
        const seen = new Set([task.id]);
        let cursor = byId.get(task.parentTaskId || '');
        while (cursor) {
            if (seen.has(cursor.id)) return true;
            seen.add(cursor.id);
            cursor = byId.get(cursor.parentTaskId || '');
        }
        return false;
    };
    for (const task of tasks) {
        const node = nodes.get(task.id)!;
        const parentId = task.parentTaskId || null;
        if (!parentId) roots.push(node);
        else if (!byId.has(parentId)) ungrouped.push(task);
        else if (cyclic(task)) roots.push(node);
        else nodes.get(parentId)!.children.push(node);
    }
    // Children of an ungrouped task would vanish with their parent's node;
    // bring them along as ungrouped too.
    const stranded: ProjectTask[] = [];
    const detach = (node: WorkNode) => {
        for (const child of node.children.splice(0)) { stranded.push(child.task); detach(child); }
    };
    for (const task of ungrouped) detach(nodes.get(task.id)!);
    return { roots, ungrouped: [...ungrouped, ...stranded] };
}

/** How far a node and everything under it is: items done, and the points over all of them. */
export function rollup(node: WorkNode): WorkRollup {
    let total = 0;
    let done = 0;
    let points = 0;
    const walk = (n: WorkNode) => {
        total += 1;
        if (n.task.status === 'done') done += 1;
        points += storyPoints(n.task) || 0;
        n.children.forEach(walk);
    };
    walk(node);
    return { total, done, points };
}

// Calendar days in UTC avoid DST changing the width or duration of a task.
const DAY = 86_400_000;
export const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
const dayKey = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayKey(dayNumber(day) + n);
export const monday = (day: string): string => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
export function taskRange(task: Pick<ProjectTask, 'startDate' | 'dueDate'>): { start: string; end: string } | null {
    const start = task.startDate || task.dueDate;
    const end = task.dueDate || task.startDate;
    return start && end ? { start, end } : null;
}
export type DateMove = 'move' | 'start' | 'end';
export function moveDates(task: Pick<ProjectTask, 'startDate' | 'dueDate'>, mode: DateMove, days: number) {
    const range = taskRange(task);
    if (!range) return null;
    if (mode === 'move') return { startDate: addDays(range.start, days), dueDate: addDays(range.end, days) };
    if (mode === 'start') return { startDate: dayKey(Math.min(dayNumber(range.end), dayNumber(range.start) + days)), dueDate: range.end };
    return { startDate: range.start, dueDate: dayKey(Math.max(dayNumber(range.start), dayNumber(range.end) + days)) };
}
export function rangePlacement(start: string, end: string, first: string, count: number) {
    const a = dayNumber(start) - dayNumber(first);
    const b = dayNumber(end) - dayNumber(first);
    if (b < 0 || a >= count) return null;
    return { left: Math.max(0, a), width: Math.min(count - 1, b) - Math.max(0, a) + 1, clippedStart: a < 0, clippedEnd: b >= count };
}

/** One timeline row in px; bars sit 6px from its top and are 28px tall. */
export const TIMELINE_ROW = 40;
const MID = TIMELINE_ROW / 2;
// Connectors travel in the 3px gutters just inside a row's edges, clear of the bars.
const GUTTER = 3;

type TimelinePosition = { task: ProjectTask; row: number; start: number; end: number };

function roundedConnector(points: [number, number][]) {
    let path = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i++) {
        const [x, y] = points[i];
        const [beforeX, beforeY] = points[i - 1];
        const [afterX, afterY] = points[i + 1];
        const radius = Math.min(5, Math.hypot(x - beforeX, y - beforeY) / 2, Math.hypot(afterX - x, afterY - y) / 2);
        path += ` L ${x - Math.sign(x - beforeX) * radius} ${y - Math.sign(y - beforeY) * radius}`;
        path += ` Q ${x} ${y} ${x + Math.sign(afterX - x) * radius} ${y + Math.sign(afterY - y) * radius}`;
    }
    return `${path} L ${points.at(-1)![0]} ${points.at(-1)![1]}`;
}

function relationshipPath(source: TimelinePosition, target: TimelinePosition, positions: TimelinePosition[], width: number, relation: TimelineRelation) {
    const lane = relation === 'parent_child' ? 4 : relation === 'related' ? -4 : 0;
    const x1 = source.end, x2 = target.start;
    const y1 = source.row * TIMELINE_ROW + MID, y2 = target.row * TIMELINE_ROW + MID;
    const between = positions.filter(position => position.row > Math.min(source.row, target.row) && position.row < Math.max(source.row, target.row));
    const clear = (x: number) => between.every(position => x < position.start || x > position.end);
    const preferred = x2 - x1 >= 24 ? (x1 + x2) / 2 + lane : Math.max(1, x2 - 10 + lane * 2);
    if (x2 - x1 >= 24 && clear(preferred)) {
        return roundedConnector([[x1, y1], [preferred, y1], [preferred, y2], [x2, y2]]);
    }
    // All relations leave the right edge and enter the left edge. Travel in
    // row gutters to avoid bars, with separate lanes for different relations.
    const candidates = [preferred, 1, width - 1, ...between.flatMap(position => [position.start - 8, position.end + 8])];
    const corridor = candidates.filter(x => x >= 1 && x <= width - 1 && clear(x)).sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred))[0];
    const down = target.row > source.row;
    const low = TIMELINE_ROW - GUTTER + lane / 2, high = GUTTER - lane / 2;
    const sourceGap = source.row * TIMELINE_ROW + (down ? low : high);
    const targetGap = target.row * TIMELINE_ROW + (down ? high : low);
    const exit = Math.min(width - 1, x1 + 10), entry = Math.max(1, x2 - 10);
    return roundedConnector([[x1, y1], [exit, y1], [exit, sourceGap], [corridor, sourceGap], [corridor, targetGap], [entry, targetGap], [entry, y2], [x2, y2]]);
}

export type TimelineRelation = 'depends_on' | 'parent_child' | 'related';

/** Connections come from the same parent and task links shown in Relationships. */
export function timelineRelations(tasks: ProjectTask[], first: string, count: number, dayWidth: number) {
    const positions = new Map(tasks.map((task, row) => {
        const range = taskRange(task);
        const position = range && rangePlacement(range.start, range.end, first, count);
        return [task.id, position ? { task, row, start: position.left * dayWidth + 2, end: (position.left + position.width) * dayWidth - 2 } : null] as const;
    }));
    const bars = [...positions.values()].filter((position): position is TimelinePosition => !!position);
    const held = new Set<string>();
    const connect = (from: string, to: string, relation: TimelineRelation) => {
        let source = positions.get(from), target = positions.get(to);
        if (!source || !target || from === to) return [];
        if (relation === 'related') {
            // Related links are undirected. Lay them out from the parent/larger
            // work item to the child, regardless of which item saved the link.
            const rank = { epic: 0, story: 1, 'user-story': 1, task: 2 };
            const sourceIsParent = target.task.parentTaskId === source.task.id;
            const targetIsParent = source.task.parentTaskId === target.task.id;
            const order = rank[workItemType(source.task)] - rank[workItemType(target.task)];
            if (targetIsParent || (!sourceIsParent && (order > 0 || (order === 0 && source.row > target.row)))) [source, target] = [target, source];
        }
        const id = `${source.task.id}:${target.task.id}`;
        const key = `${relation}:${relation === 'related' ? [from, to].sort().join(':') : id}`;
        if (held.has(key)) return [];
        held.add(key);
        const dependency = relation === 'depends_on';
        return [{
            id, relation, predecessor: source.task, successor: target.task,
            path: relationshipPath(source, target, bars, count * dayWidth, relation),
            source: { x: source.end, y: source.row * TIMELINE_ROW + MID },
            target: { x: target.start, y: target.row * TIMELINE_ROW + MID },
            conflict: dependency && taskRange(source.task)!.end >= taskRange(target.task)!.start,
        }];
    };
    return tasks.flatMap(task => {
        const hierarchy = task.parentTaskId ? connect(task.parentTaskId, task.id, 'parent_child') : [];
        const links = (task.links || []).flatMap(link => {
            if (link.kind !== 'task') return [];
            return connect(link.id, task.id, link.relation === 'depends_on' ? 'depends_on' : 'related');
        });
        return [...hierarchy, ...links];
    });
}

/** Only explicit scheduling dependencies, without inferring them from hierarchy. */
export function dependencyEdges(tasks: ProjectTask[], first: string, count: number, dayWidth: number) {
    return timelineRelations(tasks, first, count, dayWidth).filter(edge => edge.relation === 'depends_on');
}
