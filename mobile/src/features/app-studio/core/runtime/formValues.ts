/**
 * The `forms` scope root: one form's live values folded into the map every
 * formula reads. Port of agent-hub AppStudio/runtime/formValues.js.
 *
 * Returns `prev` unchanged when nothing moved, so a form re-publishing the
 * same values does not re-stamp the scope and re-render every bound component.
 */

type FormsRoot = Record<string, Record<string, unknown>>;

/** Same keys, same values by ===. Form values are flat name -> scalar maps. */
function shallowEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const A = a as Record<string, unknown>;
    const B = b as Record<string, unknown>;
    const keysA = Object.keys(A);
    if (keysA.length !== Object.keys(B).length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(B, key) && A[key] === B[key]);
}

/** Fold one form's values into the `forms` root; `prev` back when nothing moved. */
export function mergeFormValues<P extends FormsRoot | null | undefined>(
    prev: P,
    formName: string | null | undefined,
    values: Record<string, unknown> | null | undefined,
): P | FormsRoot {
    if (!formName) return prev;
    const base = (prev || {}) as FormsRoot;
    const next = values || {};
    if (Object.prototype.hasOwnProperty.call(base, formName) && shallowEqual(base[formName], next)) return base;
    return { ...base, [formName]: next };
}
