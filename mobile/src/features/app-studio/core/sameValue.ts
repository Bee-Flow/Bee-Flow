/**
 * Cheap structural equality for a variable's value or default, which may be an
 * object or an array: equal when identical or when both serialise the same.
 * definitionOps.js and appVariables.js each carry this helper; the phone keeps one.
 */
export function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}
