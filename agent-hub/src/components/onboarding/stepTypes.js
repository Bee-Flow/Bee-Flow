// Step-type discriminator for Learning Center lessons.
//
// A lesson's `steps` array can interleave seven kinds of step:
//   • tour     — the live-app spotlight walkthrough (OnboardingTour.jsx). This is
//                the ORIGINAL schema; every legacy step is a tour step.
//   • slide    — a teaching card rendered inside the LessonPlayer (markdown body).
//   • quiz     — a multiple-choice knowledge check.
//   • exercise — a free-text prompt the AI coach grades and gives pointers on.
//   • sim      — an interactive widget that IS the question (SimStep.jsx): the
//                learner assembles a flow, matches pairs, or orders steps, and
//                the widget grades locally with targeted feedback.
//   • action   — a verified do-it-for-real challenge (ActionStep.jsx): the
//                learner performs the task in the real app and "Check my work"
//                verifies it against the product's own APIs (actionChecks.js).
//   • video    — a short captioned screen recording (player/VideoStep.tsx). The
//                media lives outside git (learnMedia.ts); a video is OPTIONAL by
//                construction: it never blocks Next, never gates completion or
//                mastery, and a lesson whose media is unavailable simply plays
//                without it.
//
// BACKWARD COMPATIBILITY (load-bearing): every existing step lacks a `type`, so
// `stepType()` MUST default to 'tour'. Never read `step.type` directly anywhere
// else — always go through stepType() so the default stays in one place.

export const STEP_TYPES = {
    TOUR: 'tour',
    SLIDE: 'slide',
    QUIZ: 'quiz',
    EXERCISE: 'exercise',
    SIM: 'sim',
    ACTION: 'action',
    VIDEO: 'video',
};

export function stepType(step) {
    return step?.type || STEP_TYPES.TOUR;
}

export function isTourStep(step) {
    return stepType(step) === STEP_TYPES.TOUR;
}

export function isInlineStep(step) {
    // Anything the LessonPlayer renders itself (vs handing off to the engine).
    return !isTourStep(step);
}

// A step the learner must complete before advancing (vs an optional one they can
// skip). Slides are always satisfiable; quizzes/exercises/sims/actions gate on a
// pass unless explicitly `optional`. Tour steps follow the engine's own optional
// handling.
// Videos are never required, whatever the step says: the media may be missing
// on a deployment, and a learner who reads the captions elsewhere (or skips the
// clip) must not be locked out of the lesson.
export function stepIsRequired(step) {
    if (stepType(step) === STEP_TYPES.VIDEO) return false;
    return !step?.optional;
}

// The per-step saved statuses that satisfy a required step of each type. Sims
// accept 'revealed' (the learner asked to see the solution after real attempts —
// Brilliant-style: no punishment wall). Actions accept 'done' (honor-system
// fallback when the automatic check can't run) and 'skipped'. Videos record
// 'watched' when the clip ends; they are listed for completeness only, since
// stepIsRequired() never asks a video to be satisfied.
const SATISFYING_STATUSES = {
    [STEP_TYPES.QUIZ]: ['passed'],
    [STEP_TYPES.EXERCISE]: ['passed', 'skipped'],
    [STEP_TYPES.SIM]: ['passed', 'revealed'],
    [STEP_TYPES.ACTION]: ['passed', 'done', 'skipped'],
    [STEP_TYPES.VIDEO]: ['watched', 'skipped'],
};

export function stepStatusSatisfies(step, status) {
    const allowed = SATISFYING_STATUSES[stepType(step)];
    if (!allowed) return true; // slides + tour steps are always satisfiable
    return allowed.includes(status);
}
