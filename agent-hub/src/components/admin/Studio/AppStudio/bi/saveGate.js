/**
 * "This needs the saved model" — said once, in one place.
 *
 * The data dialog had the same rule spelled four different ways: a Save button
 * that only enables while dirty, an action button that only enables while
 * clean, an explanatory caption under one of them, and a tooltip on another —
 * with the two buttons in different parts of the window. So the reachable state
 * flipped between them and the user had to work out that "Set up a table" was
 * greyed out BECAUSE they had unsaved changes, and that the fix was a button
 * they could not see from there.
 *
 * The fix is not better copy on a disabled button. It is doing the save: an
 * action that needs the saved model saves first and then runs, and says so on
 * its own label.
 *
 * ONE EXCEPTION, deliberate: `Refresh now` writes real rows into the app's
 * database from someone's mailbox. An implicit save under that is a side effect
 * nobody asked for, so it stays gated — with the wording from here, so at least
 * the explanation is the same explanation.
 */

/** Label for an action that will save the draft first. */
export function saveFirstLabel(label, dirty, t) {
    if (!dirty) return label;
    const action = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    return t ? t('studio_apps_bi.save_gate.save_and', 'Save & {action}', { action }) : `Save & ${action}`;
}

/** Why an action that CANNOT save implicitly is unavailable, or null. */
export function saveFirstReason(dirty, t) {
    if (!dirty) return null;
    const english = 'Save your changes first — this runs against the saved model.';
    return t ? t('studio_apps_bi.save_gate.save_first', english) : english;
}

/**
 * Run `action`, saving first when the draft is dirty.
 *
 * `onSave` must resolve truthy on success; a failed save cancels the action
 * (it already reported itself — a second error would just be noise).
 */
export async function runWithSave({ dirty, onSave, action }) {
    if (dirty) {
        if (typeof onSave !== 'function') return undefined;
        const ok = await onSave();
        if (!ok) return undefined;
    }
    return action();
}
