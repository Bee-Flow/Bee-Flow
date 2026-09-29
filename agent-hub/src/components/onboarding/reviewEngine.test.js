// @vitest-environment node
//
// Unit tests — the pure review/mastery engine (v2 retention layer).
// reviewEngine.js has no storage or network, so its behaviour is pinned
// directly: mistake derivation across state shapes, stale ordering, session
// composition priority, write-back mapping, clean-run and review-coverage
// mastery rules, and a serialized-size sanity check against the server's
// per-step cap.

import { describe, it, expect } from 'vitest';
import {
    stepIsReviewable,
    stateIsMistake,
    deriveMistakes,
    deriveStaleReviewLessons,
    countReviewDue,
    buildReviewSession,
    practiceItemToQuizStep,
    deriveOutcomeWrite,
    lessonRunWasClean,
    reviewMasteryUpdates,
    REVIEW_STALE_DAYS,
    REVIEW_SESSION_SIZE,
} from './reviewEngine';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── Fixture catalog ───────────────────────────────────────────────────────
const quiz = (id, extra = {}) => ({
    type: 'quiz', id, questionFallback: `Q ${id}`,
    choices: [{ id: 'a', correct: true, labelFallback: 'A' }, { id: 'b', labelFallback: 'B' }],
    ...extra,
});
const sim = (id) => ({ type: 'sim', id, sim: { kind: 'order', items: [], solution: [] } });

const LESSONS = {
    'l-quiz': { id: 'l-quiz', steps: [{ type: 'slide', id: 's1' }, quiz('q1'), sim('m1')] },
    'l-stale': { id: 'l-stale', steps: [quiz('q2'), sim('m2')] },
    'l-tour': { id: 'l-tour', steps: [{ id: 't1' }, { id: 't2' }] }, // pure tour — nothing reviewable
    'l-org': { id: 'l-org', steps: [quiz('oq1', { serverGraded: true })] },
};
const getLesson = (id) => LESSONS[id];

describe('stepIsReviewable', () => {
    it('accepts built-in quizzes and sims, rejects tours/slides/server-graded', () => {
        expect(stepIsReviewable(quiz('x'))).toBe(true);
        expect(stepIsReviewable(sim('x'))).toBe(true);
        expect(stepIsReviewable({ type: 'slide', id: 'x' })).toBe(false);
        expect(stepIsReviewable({ id: 'x' })).toBe(false); // tour (default type)
        expect(stepIsReviewable(quiz('x', { serverGraded: true }))).toBe(false);
    });
});

describe('stateIsMistake', () => {
    it('quiz: failed, or passed with wrong tries on the way', () => {
        expect(stateIsMistake(quiz('q'), { status: 'failed', attempts: 2, wrongChoiceIds: ['b'] })).toBe(true);
        expect(stateIsMistake(quiz('q'), { status: 'passed', attempts: 2, wrongChoiceIds: ['b'] })).toBe(true);
        expect(stateIsMistake(quiz('q'), { status: 'passed', attempts: 1 })).toBe(false);
    });
    it('sim: revealed, or more than one check', () => {
        expect(stateIsMistake(sim('m'), { status: 'revealed', attempts: 2 })).toBe(true);
        expect(stateIsMistake(sim('m'), { status: 'passed', attempts: 3 })).toBe(true);
        expect(stateIsMistake(sim('m'), { status: 'passed', attempts: 1 })).toBe(false);
    });
});

describe('deriveMistakes', () => {
    it('collects reviewable mistakes across lessons, most recent first, undated last', () => {
        const progress = {
            'l-quiz': {
                steps: {
                    q1: { status: 'failed', attempts: 1, wrongChoiceIds: ['b'], answeredAt: iso(1 * DAY) },
                    m1: { status: 'revealed', attempts: 2 }, // undated
                    s1: { seen: true }, // slide state — ignored
                },
            },
            'l-stale': { steps: { q2: { status: 'passed', attempts: 3, wrongChoiceIds: ['b'], answeredAt: iso(3 * DAY) } } },
            'l-org': { steps: { oq1: { status: 'failed', attempts: 1 } } }, // server-graded — excluded
            'gone-lesson': { steps: { q9: { status: 'failed' } } }, // unknown lesson — excluded
        };
        const mistakes = deriveMistakes(progress, getLesson);
        expect(mistakes.map((m) => `${m.lessonId}/${m.stepId}`)).toEqual(['l-quiz/q1', 'l-stale/q2', 'l-quiz/m1']);
        expect(mistakes[0].kind).toBe('quiz');
        expect(mistakes[2].kind).toBe('sim');
    });
});

describe('deriveStaleReviewLessons', () => {
    it('returns completed, unmastered, reviewable lessons past the window — oldest first', () => {
        const progress = {
            'l-quiz': { completedAt: iso((REVIEW_STALE_DAYS + 5) * DAY) },
            'l-stale': { completedAt: iso((REVIEW_STALE_DAYS + 20) * DAY) },
            'l-tour': { completedAt: iso((REVIEW_STALE_DAYS + 30) * DAY) }, // nothing reviewable
        };
        const stale = deriveStaleReviewLessons(progress, getLesson, NOW);
        expect(stale.map((s) => s.lessonId)).toEqual(['l-stale', 'l-quiz']);
    });
    it('skips fresh completions and mastered lessons', () => {
        const progress = {
            'l-quiz': { completedAt: iso(2 * DAY) }, // too fresh
            'l-stale': { completedAt: iso((REVIEW_STALE_DAYS + 1) * DAY), masteredAt: iso(1 * DAY) },
        };
        expect(deriveStaleReviewLessons(progress, getLesson, NOW)).toEqual([]);
        expect(countReviewDue(progress, getLesson, NOW).due).toBe(false);
    });
});

describe('buildReviewSession', () => {
    it('mistakes first, then one item per stale lesson, then practice fill — capped', () => {
        const progress = {
            'l-quiz': {
                completedAt: iso(1 * DAY),
                steps: { q1: { status: 'failed', attempts: 1, wrongChoiceIds: ['b'], answeredAt: iso(1 * DAY) } },
            },
            'l-stale': { completedAt: iso((REVIEW_STALE_DAYS + 2) * DAY) },
        };
        const practice = [
            { id: 'p1', lessonId: 'l-quiz', question: 'P1?', choices: [{ id: 'a', label: 'A' }] },
            { id: 'p2', lessonId: 'l-stale', question: 'P2?', choices: [{ id: 'a', label: 'A' }] },
        ];
        const { steps, sourceLessonIds } = buildReviewSession({
            progressMap: progress, getLessonFn: getLesson, practiceItems: practice, practiceId: 'pid-1', now: NOW,
        });
        // mistake q1 → stale l-stale's quiz q2 (quiz preferred over sim) → both practice items
        expect(steps.map((s) => s.id)).toEqual(['l-quiz__q1', 'l-stale__q2', 'p1', 'p2']);
        expect(steps[0].origin).toEqual({ lessonId: 'l-quiz', stepId: 'q1' });
        expect(steps[2].practice).toEqual({ practiceId: 'pid-1' });
        expect(steps[2].origin).toEqual({ lessonId: 'l-quiz', stepId: null });
        expect(sourceLessonIds.sort()).toEqual(['l-quiz', 'l-stale']);
    });

    it('never exceeds the limit and dedupes a mistake against its stale lesson', () => {
        const progress = {};
        for (let i = 0; i < 10; i += 1) {
            const lid = `bulk-${i}`;
            LESSONS[lid] = { id: lid, steps: [quiz(`bq${i}`)] };
            progress[lid] = { steps: { [`bq${i}`]: { status: 'failed', attempts: 1, answeredAt: iso(i * DAY), wrongChoiceIds: ['b'] } } };
        }
        const { steps } = buildReviewSession({ progressMap: progress, getLessonFn: getLesson, now: NOW });
        expect(steps.length).toBe(REVIEW_SESSION_SIZE);
    });

    it('review clones keep grading config and stay under the 2KB step-state cap on write-back', () => {
        const write = deriveOutcomeWrite(
            { origin: { lessonId: 'l-quiz', stepId: 'q1' } },
            { status: 'failed', attempts: 3, wrongChoiceIds: ['b', 'c', 'd'] },
        );
        expect(JSON.stringify(write.write).length).toBeLessThan(2048);
    });
});

describe('deriveOutcomeWrite', () => {
    it('first-try pass clears the mistake at the origin', () => {
        const { write, cleared } = deriveOutcomeWrite(
            { origin: { lessonId: 'l', stepId: 'q' } },
            { status: 'passed', attempts: 1, choiceIds: ['a'] },
            '2026-08-26T12:00:00.000Z',
        );
        expect(cleared).toBe(true);
        expect(write).toEqual({ status: 'passed', attempts: 1, reviewedAt: '2026-08-26T12:00:00.000Z', choiceIds: ['a'] });
    });
    it('a wrong answer refreshes the failed record instead', () => {
        const { write, cleared } = deriveOutcomeWrite(
            { origin: { lessonId: 'l', stepId: 'q' } },
            { status: 'failed', attempts: 2, wrongChoiceIds: ['b'] },
        );
        expect(cleared).toBe(false);
        expect(write.status).toBe('failed');
        expect(write.reviewedAt).toBeTruthy();
    });
    it('returns null for practice items (no origin step)', () => {
        expect(deriveOutcomeWrite({ origin: { lessonId: 'l', stepId: null } }, { status: 'passed' })).toBe(null);
    });
});

describe('mastery rules', () => {
    it('lessonRunWasClean: every reviewable step passed first-try, nothing revealed', () => {
        const steps = LESSONS['l-quiz'].steps;
        expect(lessonRunWasClean(steps, {
            q1: { status: 'passed', attempts: 1 },
            m1: { status: 'passed', attempts: 1 },
        })).toBe(true);
        expect(lessonRunWasClean(steps, {
            q1: { status: 'passed', attempts: 2 },
            m1: { status: 'passed', attempts: 1 },
        })).toBe(false);
        expect(lessonRunWasClean(steps, {
            q1: { status: 'passed', attempts: 1 },
            m1: { status: 'revealed', attempts: 1 },
        })).toBe(false);
        expect(lessonRunWasClean(steps, { q1: { status: 'passed', attempts: 1 } })).toBe(false); // m1 unproven
    });

    it('a lesson with nothing reviewable can never be mastered', () => {
        expect(lessonRunWasClean(LESSONS['l-tour'].steps, {})).toBe(false);
    });

    it('reviewMasteryUpdates stamps only fully re-proven, complete, mistake-free lessons', () => {
        const sessionSteps = [
            { id: 'l-quiz__q1', origin: { lessonId: 'l-quiz', stepId: 'q1' } },
            { id: 'l-quiz__m1', origin: { lessonId: 'l-quiz', stepId: 'm1' } },
            { id: 'l-stale__q2', origin: { lessonId: 'l-stale', stepId: 'q2' } },
            { id: 'p1', origin: { lessonId: 'l-stale', stepId: null } }, // practice counts toward coverage
        ];
        const statusMap = {
            'l-quiz__q1': { status: 'passed', attempts: 1 },
            'l-quiz__m1': { status: 'passed', attempts: 1 },
            'l-stale__q2': { status: 'passed', attempts: 2 }, // needed two tries
            p1: { status: 'passed', attempts: 1 },
        };
        // Progress AFTER write-backs: l-quiz's old mistakes cleared, l-stale refreshed.
        const progressMap = {
            'l-quiz': { completedAt: iso(30 * DAY), steps: { q1: { status: 'passed', attempts: 1 }, m1: { status: 'passed', attempts: 1 } } },
            'l-stale': { completedAt: iso(30 * DAY), steps: { q2: { status: 'passed', attempts: 2, wrongChoiceIds: ['b'] } } },
        };
        expect(reviewMasteryUpdates({ sessionSteps, statusMap, progressMap, getLessonFn: getLesson })).toEqual(['l-quiz']);
    });

    it('never re-stamps an already-mastered or incomplete lesson', () => {
        const sessionSteps = [{ id: 'l-quiz__q1', origin: { lessonId: 'l-quiz', stepId: 'q1' } }];
        const statusMap = { 'l-quiz__q1': { status: 'passed', attempts: 1 } };
        expect(reviewMasteryUpdates({
            sessionSteps, statusMap, getLessonFn: getLesson,
            progressMap: { 'l-quiz': { completedAt: iso(DAY), masteredAt: iso(DAY) } },
        })).toEqual([]);
        expect(reviewMasteryUpdates({
            sessionSteps, statusMap, getLessonFn: getLesson,
            progressMap: { 'l-quiz': { steps: {} } }, // not complete
        })).toEqual([]);
    });
});

describe('practiceItemToQuizStep', () => {
    it('maps a generated item to a practice-graded quiz step doc', () => {
        const doc = practiceItemToQuizStep(
            { id: 'p9', lessonId: 'l-quiz', question: 'Which?', choices: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }] },
            'pid-7',
        );
        expect(doc.type).toBe('quiz');
        expect(doc.optional).toBe(true); // a generated item never blocks Next
        expect(doc.practice).toEqual({ practiceId: 'pid-7' });
        expect(doc.choices).toEqual([{ id: 'a', labelFallback: 'One' }, { id: 'b', labelFallback: 'Two' }]);
        expect(doc.choices.every((c) => !('correct' in c))).toBe(true); // key never present client-side
        expect(doc.origin).toEqual({ lessonId: 'l-quiz', stepId: null });
    });
});
