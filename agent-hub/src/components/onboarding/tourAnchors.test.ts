import { describe, it, expect } from 'vitest';
import { COURSES, CERTIFICATES, unknownLessonRefs } from './courses';
import { LESSONS } from './lessons';
import { stepType, STEP_TYPES } from './stepTypes';
import { KNOWN_SELECTORS, TOUR_ANCHORS } from './tourAnchors';
import { TOUR_STEPS } from './tourSteps';

// Every selector a tour step points at, across the intro tour and all lessons.
function collectTargets() {
    const targets: { target: string; stepId?: string }[] = [];
    const push = (steps?: Parameters<typeof stepType>[0][]) => (steps || []).forEach((s) => {
        const step = s as { target?: string; id?: string };
        if (stepType(s) === STEP_TYPES.TOUR && step.target) targets.push({ target: step.target, stepId: step.id });
    });
    push(TOUR_STEPS);
    LESSONS.forEach((l) => push(l.steps));
    return targets;
}

describe('tour anchor registry', () => {
    it('registers every anchor that a lesson/tour step spotlights', () => {
        const missing = collectTargets().filter(({ target }) => !KNOWN_SELECTORS.has(target));
        expect(missing, `Unregistered tour anchors (add them to tourAnchors.js): ${JSON.stringify(missing)}`).toEqual([]);
    });

    it('uses only valid reveal directives', () => {
        const VALID_SECTIONS = new Set(['identity', 'tools', 'knowledge', 'behavior']);
        Object.entries(TOUR_ANCHORS).forEach(([key, a]) => {
            expect(typeof a.selector, `${key} selector`).toBe('string');
            if (a.reveal?.designerSection) expect(VALID_SECTIONS.has(a.reveal.designerSection), `${key} section`).toBe(true);
        });
    });
});

describe('course catalog integrity', () => {
    it('references only real lessons', () => {
        expect(unknownLessonRefs()).toEqual([]);
    });

    it('has unique course ids and badge ids', () => {
        const courseIds = COURSES.map((c) => c.id);
        const badgeIds = COURSES.map((c) => c.badge?.id);
        expect(new Set(courseIds).size).toBe(courseIds.length);
        expect(new Set(badgeIds).size).toBe(badgeIds.length);
    });

    it('every certificate is a track cert or a count rule', () => {
        CERTIFICATES.forEach((cert) => {
            const ok = !!cert.track || cert.rule?.type === 'count';
            expect(ok, `certificate ${cert.id} needs a track or a count rule`).toBe(true);
        });
    });
});
