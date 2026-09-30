/**
 * A settings form as edits over what the server holds. The screens keep only
 * the keys the admin touched, so the save sends exactly those (a partial patch
 * where the server merges) and "dirty" means "differs from the server", not
 * "was typed in" — typing a value and then typing the old one back is clean.
 */

function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
}

/** The edits whose value differs from `base`. */
export function changedKeys<T extends object>(base: T, edits: Partial<T>): Partial<T> {
    const out: Partial<T> = {};
    for (const key of Object.keys(edits) as (keyof T)[]) {
        if (!same(edits[key], base[key])) out[key] = edits[key];
    }
    return out;
}

export function isEmptyPatch(patch: object): boolean {
    return Object.keys(patch).length === 0;
}
