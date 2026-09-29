// Review engine — pure logic for the Learning Center's retention layer (v2).
//
// Three jobs, all derived from the per-lesson progress blob (learningProgress):
//   • MISTAKES: which quiz/sim items the learner got wrong (or needed the
//     solution revealed for) — the Duolingo-style inventory that review
//     sessions resurface first.
//   • REVIEW SESSIONS: assemble a short mixed session (~6 items, Khan-style)
//     from mistakes → stale completed lessons → AI-generated practice items.
//     Sessions replay REAL step docs cloned with an `origin` marker; they run
//     under an ephemeral lesson id (lessons.registerEphemeralLesson) so nothing
//     persists except the write-back to each item's origin step.
//   • MASTERY: when a lesson counts as mastered — a clean run (every quiz/sim
//     passed first-try, nothing revealed) or full re-proof in a later review.
//
// Everything here is pure (no storage, no network) so it unit-tests without a
// DOM. The impure edges live in learningProgress.js (persistence) and the
// player/ReviewDueCard (assembly + UI).

import { stepType, STEP_TYPES } from './stepTypes';
import { GENERATED_PRACTICE_LESSON_IDS } from './generated/practiceLessonIds';

export const REVIEW_STALE_DAYS = 14;
export const REVIEW_SESSION_SIZE = 6;
// "First try" — at most this many attempts still counts as clean/mastered.
export const MASTERY_MAX_ATTEMPTS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

// Client mirror of server/learning/practiceTopics.js PRACTICE_LESSON_IDS — the
// lessons the AI generator can write fresh questions for. Drives where the
// "Practice" affordance shows (the served catalog's practiceLessonIds wins when
// present; this is the offline fallback). catalogLockstep.test.js fails on
// drift. Lives here rather than in practiceClient so node-environment tests
// can import it without touching window-bound helpers.
export const PRACTICE_LESSON_IDS = GENERATED_PRACTICE_LESSON_IDS;

const LEGACY_PRACTICE_LESSON_IDS = [
    'prompt-basics', 'prompt-context', 'prompt-structure', 'prompt-iterating', 'prompt-advanced',
    'effective-prompts',
    'creating-agents', 'refining-prompt', 'creating-skills', 'knowledge-bases',
    'connecting-integrations', 'using-memory',
    'automations', 'automation-anatomy', 'automation-builder-tour', 'automation-build-sim', 'automation-practice',
    'cowork-basics', 'cowork-briefs', 'cowork-hands-on',
    'org-usage', 'admin-access-control', 'admin-governance',
];

/* ── What can be reviewed ────────────────────────────────────────────────── */

// A step the review engine can replay outside its lesson: built-in quizzes
// (local answer key) and sims. Server-graded org quizzes are excluded — their
// grading endpoint needs the real org lesson id, which an ephemeral session
// doesn't carry.
export function stepIsReviewable(step) {
    const ty = stepType(step);
    if (ty === STEP_TYPES.SIM) return !!step?.sim;
    if (ty === STEP_TYPES.QUIZ) return !step?.serverGraded && (step?.choices || []).length > 0;
    return false;
}

export function reviewableSteps(lesson) {
    return (lesson?.steps || []).filter(stepIsReviewable);
}

/* ── Mistakes ────────────────────────────────────────────────────────────── */

// True when a saved step state records a struggle worth revisiting. Quizzes:
// a failed submission, or a pass that needed wrong tries on the way. Sims: the
// solution was revealed, or it took more than one check.
export function stateIsMistake(step, state) {
    if (!state || typeof state !== 'object') return false;
    const ty = stepType(step);
    if (ty === STEP_TYPES.QUIZ) {
        if (state.status === 'failed') return true;
        return state.status === 'passed' && Array.isArray(state.wrongChoiceIds) && state.wrongChoiceIds.length > 0;
    }
    if (ty === STEP_TYPES.SIM) {
        if (state.status === 'revealed') return true;
        return typeof state.attempts === 'number' && state.attempts > MASTERY_MAX_ATTEMPTS;
    }
    return false;
}

// The cross-lesson mistakes inventory: [{ lessonId, stepId, kind, at }],
// most recent first (undated entries last). Only reviewable steps qualify —
// a mistake we couldn't replay would be a dead entry.
export function deriveMistakes(progressMap, getLessonFn) {
    const out = [];
    for (const [lessonId, entry] of Object.entries(progressMap || {})) {
        const steps = entry && typeof entry === 'object' ? entry.steps : null;
        if (!steps) continue;
        const lesson = getLessonFn(lessonId);
        if (!lesson) continue;
        for (const [stepId, state] of Object.entries(steps)) {
            const step = (lesson.steps || []).find((s) => s.id === stepId);
            if (!step || !stepIsReviewable(step)) continue;
            if (!stateIsMistake(step, state)) continue;
            out.push({ lessonId, stepId, kind: stepType(step), at: state.answeredAt || state.reviewedAt || null });
        }
    }
    return out.sort((a, b) => {
        if (a.at && b.at) return a.at < b.at ? 1 : -1;
        if (a.at || b.at) return a.at ? -1 : 1;
        return 0;
    });
}

/* ── Staleness ───────────────────────────────────────────────────────────── */

// Completed-but-not-mastered lessons whose completion is older than the stale
// window and that have something replayable — oldest first, so the longest-
// unvisited knowledge resurfaces soonest. Mastered lessons are done proving
// themselves and stay out.
export function deriveStaleReviewLessons(progressMap, getLessonFn, now = Date.now()) {
    const out = [];
    for (const [lessonId, entry] of Object.entries(progressMap || {})) {
        if (!entry || typeof entry !== 'object' || !entry.completedAt || entry.masteredAt) continue;
        const ts = Date.parse(entry.completedAt);
        if (Number.isNaN(ts) || now - ts < REVIEW_STALE_DAYS * DAY_MS) continue;
        const lesson = getLessonFn(lessonId);
        if (!lesson || !reviewableSteps(lesson).length) continue;
        out.push({ lessonId, completedAt: entry.completedAt });
    }
    return out.sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1));
}

// What the "Review due" card shows: how much material a session would have.
export function countReviewDue(progressMap, getLessonFn, now = Date.now()) {
    const mistakes = deriveMistakes(progressMap, getLessonFn).length;
    const staleLessons = deriveStaleReviewLessons(progressMap, getLessonFn, now).length;
    return { mistakes, staleLessons, due: mistakes + staleLessons > 0 };
}

/* ── Session assembly ────────────────────────────────────────────────────── */

// Clone a real step doc into a session: same config (so grading/feedback work
// identically), a session-unique id (step ids are only unique per lesson), and
// an `origin` pointer for the write-back + mastery math.
function cloneStepForReview(lesson, step) {
    return { ...step, id: `${lesson.id}__${step.id}`, origin: { lessonId: lesson.id, stepId: step.id } };
}

// A "Practice again" fallback when AI generation is unavailable: the lesson's
// own quiz/sim items, cloned with origins like any review item.
export function lessonPracticeSteps(lesson) {
    return reviewableSteps(lesson).map((s) => cloneStepForReview(lesson, s));
}

// An AI-generated practice item as a quiz step doc. `practice.practiceId`
// routes QuizStep to POST /ai/learning/practice/grade (the answer key never
// ships); `origin.stepId` stays null — practice items count toward a lesson's
// review coverage but never write into its step state.
export function practiceItemToQuizStep(item, practiceId) {
    return {
        type: STEP_TYPES.QUIZ,
        id: item.id,
        icon: '✨',
        generated: true,
        // Optional: a generated question is a bonus rep, never a wall — if the
        // model wrote a bad item, the learner can move on (it still grades and
        // still counts toward review coverage when answered).
        optional: true,
        questionFallback: item.question,
        choices: (item.choices || []).map((c) => ({ id: c.id, labelFallback: c.label })),
        practice: { practiceId },
        origin: { lessonId: item.lessonId || null, stepId: null },
    };
}

// Build one mixed session: mistakes first (the whole point), then one item per
// stale lesson (oldest first, quiz preferred over sim — lighter to replay),
// then AI practice items to fill. Returns { steps, sourceLessonIds }.
export function buildReviewSession({
    progressMap, getLessonFn, practiceItems = [], practiceId = null,
    now = Date.now(), limit = REVIEW_SESSION_SIZE,
} = {}) {
    const steps = [];
    const seen = new Set(); // `${lessonId}|${stepId}` already in the session
    const sourceLessonIds = new Set();

    const push = (lesson, step) => {
        const key = `${lesson.id}|${step.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        steps.push(cloneStepForReview(lesson, step));
        sourceLessonIds.add(lesson.id);
    };

    for (const m of deriveMistakes(progressMap, getLessonFn)) {
        if (steps.length >= limit) break;
        const lesson = getLessonFn(m.lessonId);
        const step = (lesson?.steps || []).find((s) => s.id === m.stepId);
        if (lesson && step) push(lesson, step);
    }

    for (const s of deriveStaleReviewLessons(progressMap, getLessonFn, now)) {
        if (steps.length >= limit) break;
        const lesson = getLessonFn(s.lessonId);
        const candidates = reviewableSteps(lesson)
            .sort((a, b) => (stepType(a) === STEP_TYPES.QUIZ ? 0 : 1) - (stepType(b) === STEP_TYPES.QUIZ ? 0 : 1));
        const fresh = candidates.find((c) => !seen.has(`${lesson.id}|${c.id}`));
        if (fresh) push(lesson, fresh);
    }

    for (const item of practiceItems) {
        if (steps.length >= limit) break;
        const doc = practiceItemToQuizStep(item, practiceId);
        steps.push(doc);
        if (doc.origin.lessonId) sourceLessonIds.add(doc.origin.lessonId);
    }

    return { steps, sourceLessonIds: [...sourceLessonIds] };
}

/* ── Write-back & mastery ────────────────────────────────────────────────── */

// Map a session answer onto the origin step's state. A first-try pass CLEARS
// the mistake (clean passing state); anything else refreshes the record so the
// item stays in the inventory. Returns null for items with no origin step
// (AI practice) — nothing to write.
export function deriveOutcomeWrite(step, state, now = new Date().toISOString()) {
    if (!step?.origin?.stepId || !state) return null;
    if (state.status === 'passed' && (state.attempts || 1) <= MASTERY_MAX_ATTEMPTS) {
        return {
            write: {
                status: 'passed', attempts: 1, reviewedAt: now,
                ...(Array.isArray(state.choiceIds) ? { choiceIds: state.choiceIds } : {}),
            },
            cleared: true,
        };
    }
    return { write: { ...state, reviewedAt: now }, cleared: false };
}

// Clean-run check for a real lesson at finish time: every reviewable step has
// a first-try pass recorded. A lesson with nothing reviewable can't be
// mastered — there is no knowledge item to re-prove.
export function lessonRunWasClean(steps, stateMap) {
    const reviewable = (steps || []).filter(stepIsReviewable);
    if (!reviewable.length) return false;
    return reviewable.every((s) => {
        const st = stateMap?.[s.id];
        return st?.status === 'passed' && (st.attempts || 1) <= MASTERY_MAX_ATTEMPTS;
    });
}

// After a review session: which source lessons earned their mastery stamp?
// A lesson qualifies when every one of its session items passed first-try,
// it is complete, not yet mastered, and — after the session's write-backs —
// its mistake inventory is empty.
export function reviewMasteryUpdates({ sessionSteps, statusMap, progressMap, getLessonFn }) {
    const byLesson = new Map();
    for (const s of sessionSteps || []) {
        const lid = s?.origin?.lessonId;
        if (!lid) continue;
        if (!byLesson.has(lid)) byLesson.set(lid, []);
        byLesson.get(lid).push(s);
    }
    const mistakes = deriveMistakes(progressMap, getLessonFn);
    const mastered = [];
    for (const [lessonId, items] of byLesson) {
        const entry = progressMap?.[lessonId];
        if (!entry?.completedAt || entry.masteredAt) continue;
        const allFirstTry = items.every((s) => {
            const st = statusMap?.[s.id];
            return st?.status === 'passed' && (st.attempts || 1) <= MASTERY_MAX_ATTEMPTS;
        });
        if (!allFirstTry) continue;
        if (mistakes.some((m) => m.lessonId === lessonId)) continue;
        mastered.push(lessonId);
    }
    return mastered;
}
