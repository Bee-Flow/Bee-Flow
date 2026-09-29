// Step-type discriminator for Learning Center lessons.
//
// A lesson's `steps` array can interleave six kinds of step:
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
export function stepIsRequired(step) {
    return !step?.optional;
}

// The per-step saved statuses that satisfy a required step of each type. Sims
// accept 'revealed' (the learner asked to see the solution after real attempts —
// Brilliant-style: no punishment wall). Actions accept 'done' (honor-system
// fallback when the automatic check can't run) and 'skipped'.
const SATISFYING_STATUSES = {
    [STEP_TYPES.QUIZ]: ['passed'],
    [STEP_TYPES.EXERCISE]: ['passed', 'skipped'],
    [STEP_TYPES.SIM]: ['passed', 'revealed'],
    [STEP_TYPES.ACTION]: ['passed', 'done', 'skipped'],
};

export function stepStatusSatisfies(step, status) {
    const allowed = SATISFYING_STATUSES[stepType(step)];
    if (!allowed) return true; // slides + tour steps are always satisfiable
    return allowed.includes(status);
}
