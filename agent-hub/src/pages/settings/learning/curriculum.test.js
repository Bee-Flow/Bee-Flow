import { describe, it, expect } from 'vitest';
import {
    buildCurriculumColumns, splitCapstone, courseSegments, courseState, stepMix,
    lessonPlays, nextLessonIn, masteryStillReachable, lessonsMinutes, SEGMENT, CAPSTONE_COURSE_ID,
} from './curriculum';
import { COURSES } from '../../../components/onboarding/courses';
import { LEARNING_PATHS } from '../../../components/onboarding/learningPaths';

describe('buildCurriculumColumns', () => {
    it('puts every non-capstone course in exactly one column, first path wins', () => {
        const cols = buildCurriculumColumns(COURSES);
        const seen = cols.flatMap((c) => c.courses.map((x) => x.id));
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).not.toContain(CAPSTONE_COURSE_ID);
        expect(seen.sort()).toEqual(COURSES.map((c) => c.id).filter((id) => id !== CAPSTONE_COURSE_ID).sort());
        // Foundations is on all three paths; it belongs to the first one only.
        expect(cols[0].pathId).toBe(LEARNING_PATHS[0].id);
        expect(cols[0].courses.map((c) => c.id)).toContain('course-foundations');
        expect(cols[1].courses.map((c) => c.id)).not.toContain('course-foundations');
    });

    it('moves the active path to the front without reordering the rest', () => {
        const base = buildCurriculumColumns(COURSES).map((c) => c.pathId);
        const cols = buildCurriculumColumns(COURSES, 'admin').map((c) => c.pathId);
        expect(cols[0]).toBe('admin');
        expect(cols.slice(1)).toEqual(base.filter((p) => p !== 'admin'));
    });

    it('collects courses no path claims in a trailing column', () => {
        const org = { id: 'org-course-x', lessonIds: [] };
        const cols = buildCurriculumColumns([...COURSES, org]);
        const last = cols.at(-1);
        expect(last.pathId).toBeNull();
        expect(last.courses.map((c) => c.id)).toContain('org-course-x');
    });
});

describe('splitCapstone', () => {
    it('pulls the capstone out', () => {
        const { capstone, rest } = splitCapstone(COURSES);
        expect(capstone?.id).toBe(CAPSTONE_COURSE_ID);
        expect(rest.some((c) => c.id === CAPSTONE_COURSE_ID)).toBe(false);
    });
});

describe('courseSegments — the one progress idiom', () => {
    const lessons = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    it('mastered > complete > open, and mastery needs completion', () => {
        expect(courseSegments(lessons, { a: true, b: true }, { a: true, c: true }))
            .toEqual([SEGMENT.MASTERED, SEGMENT.COMPLETE, SEGMENT.OPEN]);
    });
    it('a locked course is all dashed regardless of progress', () => {
        expect(courseSegments(lessons, { a: true }, {}, true)).toEqual([SEGMENT.LOCKED, SEGMENT.LOCKED, SEGMENT.LOCKED]);
    });
});

describe('courseState', () => {
    const lessons = [{ id: 'a' }, { id: 'b' }];
    it('resolves the four states', () => {
        expect(courseState({ lessons, completedMap: {}, locked: true, complete: false })).toBe('locked');
        expect(courseState({ lessons, completedMap: { a: true, b: true }, locked: false, complete: true })).toBe('complete');
        expect(courseState({ lessons, completedMap: { a: true }, locked: false, complete: false })).toBe('in_progress');
        expect(courseState({ lessons, completedMap: {}, locked: false, complete: false })).toBe('not_started');
    });
});

describe('step helpers', () => {
    const lesson = { steps: [{ id: 's1' }, { id: 's2', type: 'quiz' }, { id: 's3', type: 'action' }, { id: 's4', type: 'slide' }] };
    it('counts the mix and treats a typeless step as a tour step', () => {
        expect(stepMix(lesson)).toEqual({ slide: 1, quiz: 1, exercise: 0, sim: 0, action: 1, tour: 1 });
    });
    it('a lesson with an action step plays beside the app', () => {
        expect(lessonPlays(lesson)).toBe('docked');
        expect(lessonPlays({ steps: [{ type: 'slide' }, { type: 'quiz' }] })).toBe('modal');
    });
    it('finds the next lesson with a 1-based position', () => {
        const lessons = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        expect(nextLessonIn(lessons, { a: true })).toEqual({ lesson: lessons[1], index: 2 });
        expect(nextLessonIn(lessons, { a: true, b: true, c: true })).toBeNull();
    });
    it('mastery stays reachable until something was failed or revealed', () => {
        const steps = [{ id: 'q' }, { id: 's' }];
        expect(masteryStillReachable(steps, {})).toBe(true);
        expect(masteryStillReachable(steps, { q: { status: 'passed', attempts: 1 } })).toBe(true);
        expect(masteryStillReachable(steps, { q: { status: 'passed', attempts: 2 } })).toBe(false);
        expect(masteryStillReachable(steps, { s: { status: 'revealed' } })).toBe(false);
    });
    it('sums minutes', () => {
        expect(lessonsMinutes([{ estMinutes: 5 }, { estMinutes: 6.4 }])).toBe(11);
        expect(lessonsMinutes([])).toBe(0);
    });
});
