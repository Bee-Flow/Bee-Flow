// Curriculum map helpers for the redesigned Learning Center (handoff
// "Learning Center.dc.html", Sep 2026). Pure — no DOM, no network — so the
// partitioning and the one progress idiom unit-test on their own.
//
// The design draws the catalog as THREE columns (one per learning path) plus
// the capstone as a full-width end station. A course lives in exactly ONE
// column: the first path (in LEARNING_PATHS order) whose courseOrder lists it.
// Courses no path lists (org-authored ones) collect in an extra column so a
// course a learner can see is never a course the map hides. The learner's own
// path is drawn first — "jouw pad staat vooraan".

import { LEARNING_PATHS } from '../../../components/onboarding/learningPaths';
import { defaultLayoutForSteps, LAYOUTS } from '../../../components/onboarding/player/playerLayout';
import { stepType, STEP_TYPES } from '../../../components/onboarding/stepTypes';

export const CAPSTONE_COURSE_ID = 'course-hive-master';
export const CAPSTONE_CHECK_ID = 'hive-master';

/** Which certificate a path column reports on (the artboard's column header). */
export const PATH_CERTIFICATE = Object.freeze({
    everyday: 'cert-foundations',
    builder: 'cert-builder',
    admin: 'cert-practitioner',
});

/** The four segment states of the one progress idiom. */
export const SEGMENT = Object.freeze({
    MASTERED: 'mastered',
    COMPLETE: 'complete',
    OPEN: 'open',
    LOCKED: 'locked',
});

/**
 * courses → [{ pathId, courses }] in column order. `activePathId` moves that
 * path to the front; unknown/absent path keeps LEARNING_PATHS order. The
 * capstone is never in a column (it is returned separately by
 * `splitCapstone`), and a course no path claims lands in a trailing column
 * with pathId `null`.
 */
export function buildCurriculumColumns(courses, activePathId = null) {
    const claimed = new Set();
    const columns = LEARNING_PATHS.map((p) => {
        const list = [];
        for (const id of p.courseOrder) {
            if (claimed.has(id) || id === CAPSTONE_COURSE_ID) continue;
            const course = (courses || []).find((c) => c.id === id);
            if (!course) continue;
            claimed.add(id);
            list.push(course);
        }
        return { pathId: p.id, courses: list };
    });
    const rest = (courses || []).filter((c) => !claimed.has(c.id) && c.id !== CAPSTONE_COURSE_ID);
    if (rest.length) columns.push({ pathId: null, courses: rest });
    if (activePathId) {
        const i = columns.findIndex((c) => c.pathId === activePathId);
        if (i > 0) columns.unshift(...columns.splice(i, 1));
    }
    return columns;
}

/** { capstone, rest } — the capstone course pulled out of a course list. */
export function splitCapstone(courses) {
    const capstone = (courses || []).find((c) => c.id === CAPSTONE_COURSE_ID) || null;
    const rest = (courses || []).filter((c) => c.id !== CAPSTONE_COURSE_ID);
    return { capstone, rest };
}

/**
 * One segment per lesson: gold when mastered, green when complete, grey when
 * open, dashed when the course itself is locked. Mastery only paints on a
 * lesson that is also complete — the same rule as the XP math.
 */
export function courseSegments(lessons, completedMap, masteredMap = {}, locked = false) {
    return (lessons || []).map((l) => {
        if (locked) return SEGMENT.LOCKED;
        if (!completedMap?.[l.id]) return SEGMENT.OPEN;
        return masteredMap?.[l.id] ? SEGMENT.MASTERED : SEGMENT.COMPLETE;
    });
}

/** 'locked' | 'complete' | 'in_progress' | 'not_started' — the card's right-hand affordance. */
export function courseState({ lessons, completedMap, locked, complete }) {
    if (locked) return 'locked';
    if (complete) return 'complete';
    const done = (lessons || []).filter((l) => !!completedMap?.[l.id]).length;
    return done > 0 ? 'in_progress' : 'not_started';
}

/** Ordered step-kind list of a lesson (the "Stappen" column draws one icon each). */
export function lessonStepKinds(lesson) {
    return (lesson?.steps || []).map(stepType);
}

/** { slide, quiz, exercise, sim, action, tour } counts for a lesson or a whole course. */
export function stepMix(lessons) {
    const mix = { slide: 0, quiz: 0, exercise: 0, sim: 0, action: 0, tour: 0 };
    for (const lesson of Array.isArray(lessons) ? lessons : [lessons]) {
        for (const kind of lessonStepKinds(lesson)) if (kind in mix) mix[kind] += 1;
    }
    return mix;
}

/** Where the lesson opens by default: 'docked' (beside the app) or 'modal' (in a window). */
export function lessonPlays(lesson) {
    return defaultLayoutForSteps(lesson?.steps || []) === LAYOUTS.DOCKED ? 'docked' : 'modal';
}

/** True when a lesson has a do-it-for-real step (action or tour). */
export function lessonIsLearnAlong(lesson) {
    return (lesson?.steps || []).some((s) => {
        const k = stepType(s);
        return k === STEP_TYPES.ACTION || k === STEP_TYPES.TOUR;
    });
}

/** The first not-complete lesson of a course, with its 1-based position. */
export function nextLessonIn(lessons, completedMap) {
    const idx = (lessons || []).findIndex((l) => !completedMap?.[l.id]);
    return idx === -1 ? null : { lesson: lessons[idx], index: idx + 1 };
}

/** "Mastery still reachable": no step of the lesson has been failed or revealed yet. */
export function masteryStillReachable(lessonSteps, stepState) {
    for (const step of lessonSteps || []) {
        const saved = stepState?.[step.id];
        if (!saved) continue;
        if (saved.status === 'revealed' || saved.status === 'failed') return false;
        if (typeof saved.attempts === 'number' && saved.attempts > 1) return false;
    }
    return true;
}

/** Sum of estMinutes over lessons (rounded, ≥ 1 when any lesson exists). */
export function lessonsMinutes(lessons) {
    const total = (lessons || []).reduce((n, l) => n + (Number(l?.estMinutes) || 0), 0);
    return lessons?.length ? Math.max(1, Math.round(total)) : 0;
}
