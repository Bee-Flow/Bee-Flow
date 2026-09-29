// Cross-surface navigation into the Learning Center.
//
// The lesson player is mounted at App level and outlives the settings page, so
// its completion screen cannot hand the learner "back to the course" through
// props. It dispatches this event instead; the Learning Center section
// listens while mounted and — because the section may not be mounted yet
// when the player fires (the learner may be anywhere in the app) — the last
// request is also parked here and consumed on the section's next mount.

export const LEARNING_NAVIGATE_EVENT = 'beeflow:learning-navigate';

let pending = null;

/** { view: 'overview'|'review'|'achievements'|'course', courseId? } */
export function requestLearningNavigate(detail) {
    pending = detail || null;
    try { window.dispatchEvent(new CustomEvent(LEARNING_NAVIGATE_EVENT, { detail })); } catch (_) { /* no window */ }
}

/** The parked request, cleared on read. */
export function takePendingLearningNavigate() {
    const p = pending;
    pending = null;
    return p;
}
