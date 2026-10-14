/** Freezes a fixture tree so an accidental mutation throws in tests and dev. */
export function deepFreeze<T>(obj: T): T {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
        Object.freeze(obj);
        for (const value of Object.values(obj as object)) deepFreeze(value);
    }
    return obj;
}
