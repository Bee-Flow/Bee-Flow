// Learning paths (v2) — the three role/goal tracks the Learning Center home
// can organise itself around. Pure data + ordering logic (node-safe, no DOM);
// the stored choice lives in learningPath.js.
//
// A path is presentation only: it REORDERS the visible courses (its courseOrder
// first, everything else in catalog order after) and steers the "Next up" hero.
// It never gates content — every visible course stays reachable on every path.

import { GENERATED_PATH_ORDER } from './generated/pathOrder';

// courseOrder is DERIVED from the catalog (every course declares its pathId), not
// hand-listed: with the 2026-09 curriculum the hand-written lists covered 9 of 20
// courses and the other 11 fell into the unclaimed trailing column.
export const LEARNING_PATHS = [
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

LEARNING_PATHS.forEach((p) => { p.courseOrder = GENERATED_PATH_ORDER[p.id] || []; });

export function getLearningPath(pathId) {
    return LEARNING_PATHS.find((p) => p.id === pathId) || null;
}

// Stable reorder: the path's courses first (in its order), every other course
// after in the order it arrived. Unknown/absent path → untouched input.
export function orderCoursesForPath(courses, pathId) {
    const path = getLearningPath(pathId);
    if (!path) return courses;
    const rank = new Map(path.courseOrder.map((id, i) => [id, i]));
    const first = [];
    const rest = [];
    for (const c of courses || []) {
        if (rank.has(c.id)) first.push(c); else rest.push(c);
    }
    first.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return [...first, ...rest];
}
