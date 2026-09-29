// Player layout resolution (v2 "learn-along" mode).
//
// The LessonPlayer renders either as the classic centered MODAL or DOCKED as a
// right-side panel with the app fully interactive beside it — the Codecademy
// layout: instructions stay readable while the learner does the real thing.
// The pure pieces live here so the defaulting rules unit-test without a DOM.
//
// Rules:
//   • an explicit per-user preference (scopedStorage) always wins;
//   • otherwise a lesson that contains action or tour steps — the "go do it in
//     the real app" lessons — defaults to docked, everything else to modal;
//   • mobile (<768px) is always modal: there is no "beside" on a phone.

import scopedStorage from '../../../utils/scopedStorage';
import { stepType, STEP_TYPES } from '../stepTypes';

export const DOCK_PREF_KEY = 'learnPlayerLayout';
export const LAYOUTS = { MODAL: 'modal', DOCKED: 'docked' };

export function isMobileViewport() {
    try {
        return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
    } catch (_) {
        return false;
    }
}

// Docked by default only for lessons the learner works ALONGSIDE: verified
// hands-on (action) steps and live-app tour segments.
export function defaultLayoutForSteps(steps) {
    const learnAlong = (steps || []).some((s) => {
        const ty = stepType(s);
        return ty === STEP_TYPES.ACTION || ty === STEP_TYPES.TOUR;
    });
    return learnAlong ? LAYOUTS.DOCKED : LAYOUTS.MODAL;
}

// Pure resolution: mobile forces modal; a stored preference wins; otherwise
// the step-mix default applies.
export function resolveInitialLayout(steps, storedPref, mobile) {
    if (mobile) return LAYOUTS.MODAL;
    if (storedPref === LAYOUTS.DOCKED || storedPref === LAYOUTS.MODAL) return storedPref;
    return defaultLayoutForSteps(steps);
}

/* ── Per-user preference (scopedStorage mirror, best-effort) ─────────────── */

export function readDockPref(user) {
    try {
        if (user?.id) scopedStorage.setCurrentUser(user.id);
        const v = scopedStorage.getItem(DOCK_PREF_KEY);
        return v === LAYOUTS.DOCKED || v === LAYOUTS.MODAL ? v : null;
    } catch (_) {
        return null;
    }
}

export function saveDockPref(user, layout) {
    try {
        if (user?.id) scopedStorage.setCurrentUser(user.id);
        scopedStorage.setItem(DOCK_PREF_KEY, layout);
    } catch (_) { /* preference only — losing it is fine */ }
}
