// Where the learner lands when a tour finishes (BFSF-472).
//
// The intro tour ends with a home-jump to Direct chat — but only for
// first-time onboarding, where the tour auto-starts on the chat home and the
// jump hands the freshly-shown app to the new user. The same lesson replayed
// from the Learning Center used to inherit that jump, so finishing "Getting
// started" from the Academy dropped the learner on Direct chat instead of back
// at their course. The start context travels with TOUR_START_EVENT
// (`detail.returnTo`): a starter that names a return page gets the learner
// back there, and the home-jump stays reserved for runs without one.

/**
 * resolveTourCompletionNavigation — the page key to navigate to on finish, or
 * null to leave the learner where the tour ended.
 *
 *   returnTo set        → that page (whoever started the tour owns the return)
 *   intro + navigated   → 'agents' (first-time onboarding lands back on chat)
 *   anything else       → null
 *
 * @param {{ isIntro: boolean, navigated: boolean, returnTo?: string|null }} args
 */
export function resolveTourCompletionNavigation({ isIntro, navigated, returnTo } = {}) {
    if (typeof returnTo === 'string' && returnTo) return returnTo;
    if (isIntro && navigated) return 'agents';
    return null;
}
