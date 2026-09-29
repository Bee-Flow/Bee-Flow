// @vitest-environment node
//
// Unit tests — learning path ordering (v2). Includes the drift tripwire: every
// course id a path references must exist in the bundled catalog, so a renamed
// or removed course fails the build instead of silently breaking a path.

import { describe, it, expect } from 'vitest';
import { LEARNING_PATHS, getLearningPath, orderCoursesForPath } from './learningPaths';
import { COURSES } from './courses';

const byIds = (ids) => ids.map((id) => ({ id }));

describe('orderCoursesForPath', () => {
    // Asserts the PROPERTY, not a hard-coded id list: courseOrder is derived
    // from the catalog now (every course declares its pathId), so pinning ids
    // here would only re-assert the catalog and break on every curriculum edit.
    it('puts the path\'s courses first in path order, the rest in arrival order', () => {
        const everyday = getLearningPath('everyday').courseOrder;
        const [a, b] = [everyday[1], everyday[0]];            // two path courses, reversed
        const outsider = COURSES.map((c) => c.id).find((id) => !everyday.includes(id));
        const out = orderCoursesForPath(byIds([outsider, a, b]), 'everyday');
        expect(out.map((c) => c.id)).toEqual([b, a, outsider]);
    });

    it('is stable for unknown or absent paths', () => {
        const input = byIds(['course-power', 'course-foundations']);
        expect(orderCoursesForPath(input, null)).toBe(input);
        expect(orderCoursesForPath(input, 'nope')).toBe(input);
        expect(orderCoursesForPath(input, 'skipped')).toBe(input);
    });

    it('handles a filtered course list (gated courses missing) gracefully', () => {
        const input = byIds(['course-cowork']); // builder path courses all gated away
        expect(orderCoursesForPath(input, 'builder').map((c) => c.id)).toEqual(['course-cowork']);
    });
});

describe('path registry integrity', () => {
    it('every courseOrder id exists in the bundled catalog (drift tripwire)', () => {
        const known = new Set(COURSES.map((c) => c.id));
        for (const path of LEARNING_PATHS) {
            for (const id of path.courseOrder) {
                expect(known.has(id), `path ${path.id} references unknown course ${id}`).toBe(true);
            }
        }
    });

    it('paths have unique ids and getLearningPath resolves them', () => {
        const ids = LEARNING_PATHS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(getLearningPath(id)?.id).toBe(id);
        expect(getLearningPath('skipped')).toBe(null);
    });
});
