/**
 * App Studio runtime — the `forms` scope root, shared by both surfaces.
 *
 * AppForm publishes its live values through registerFormValue (a mount/change
 * EFFECT, see AppForm.jsx), and the host — RunSurface in pages/apps/AppRunPage
 * and Canvas in the editor — folds them into one `forms` object that feeds
 * buildScope. Both hosts held their own copy of that fold; this is the single
 * one, so preview and production cannot drift apart again.
 *
 * The guard matters on its own: the fold used to allocate a new `forms` object
 * on EVERY call, including the calls that carry values the scope already has.
 * A new `forms` identity re-memos buildScope, which re-renders every bound
 * component on the screen — so one form re-registering could ripple through the
 * whole app for no change at all. Publishing identical values is now free.
 */

/** Same keys, same values by ===. Form values are flat name → scalar maps. */
function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) return false;
    }
    return true;
}

/**
 * Fold one form's values into the `forms` root.
 * Returns `prev` UNCHANGED when nothing actually moved, so React bails out.
 */
export function mergeFormValues(prev, formName, values) {
    if (!formName) return prev;
    const base = prev || {};
    const next = values || {};
    if (Object.prototype.hasOwnProperty.call(base, formName) && shallowEqual(base[formName], next)) {
        return base;
    }
    return { ...base, [formName]: next };
}
