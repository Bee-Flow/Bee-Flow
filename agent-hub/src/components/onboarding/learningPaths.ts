// Learning paths (v2) — the three role/goal tracks the Learning Center home
// can organise itself around. Pure data + ordering logic (node-safe, no DOM);
// the stored choice lives in learningPath.js.
//
// A path is presentation only: it REORDERS the visible courses (its courseOrder
// first, everything else in catalog order after) and steers the "Next up" hero.
// It never gates content — every visible course stays reachable on every path.

import { GENERATED_PATH_ORDER } from './generated/pathOrder';
import type { LearningPath } from '../../api/lessons.types';

// courseOrder is DERIVED from the catalog (every course declares its pathId), not
// hand-listed: with the 2026-09 curriculum the hand-written lists covered 9 of 20
// courses and the other 11 fell into the unclaimed trailing column.
export const LEARNING_PATHS: LearningPath[] = [
    {
        id: 'everyday',
        icon: '💬',
        titleKey: 'learn.path.everyday', titleFallback: 'Everyday work',
        descKey: 'learn.path.everyday_desc',
        descFallback: 'Chat well, delegate to Cowork, and let Bee Flow remember for you.',
        courseOrder: [],
    },
    {
        id: 'builder',
        icon: '🛠️',
        titleKey: 'learn.path.builder', titleFallback: 'Build agents & automations',
        descKey: 'learn.path.builder_desc',
        descFallback: 'Create agents, wire automations on the canvas, and prove it in the capstone.',
        courseOrder: [],
    },
    {
        id: 'admin',
        icon: '🛡️',
        titleKey: 'learn.path.admin', titleFallback: 'Run the workspace',
        descKey: 'learn.path.admin_desc',
        descFallback: 'Access control, usage monitoring, integrations and healthy rollouts.',
        courseOrder: [],
    },
];

LEARNING_PATHS.forEach((p: LearningPath) => { p.courseOrder = (GENERATED_PATH_ORDER as Record<string, string[]>)[p.id] || []; });

export function getLearningPath(pathId: string | null | undefined): LearningPath | null {
    return LEARNING_PATHS.find((p) => p.id === pathId) || null;
}

// Stable reorder: the path's courses first (in its order), every other course
// after in the order it arrived. Unknown/absent path → untouched input.
export function orderCoursesForPath<T extends { id: string }>(courses: T[], pathId: string | null | undefined): T[];
export function orderCoursesForPath<T extends { id: string }>(courses: T[] | null | undefined, pathId: string | null | undefined): T[] | null | undefined;
export function orderCoursesForPath<T extends { id: string }>(courses: T[] | null | undefined, pathId: string | null | undefined): T[] | null | undefined {
    const path = getLearningPath(pathId);
    if (!path) return courses;
    const rank = new Map<string, number>(path.courseOrder.map((id: string, i: number): [string, number] => [id, i]));
    const first: T[] = [];
    const rest: T[] = [];
    for (const c of courses || []) {
        if (rank.has(c.id)) first.push(c); else rest.push(c);
    }
    first.sort((a: T, b: T) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
    return [...first, ...rest];
}
