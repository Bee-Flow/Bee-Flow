/**
 * The list edits every bespoke editor makes — pure, never mutating, each a
 * copy of the web editors' own one-liners (`rows.map((r, j) => j === i ? …)`,
 * the swap in `move(i, dir)`), so the rows' objects travel whole.
 */

export function patchAt<T extends object>(rows: readonly T[], i: number, patch: Partial<T>): T[] {
    return rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
}

export function replaceAt<T>(rows: readonly T[], i: number, next: T): T[] {
    return rows.map((r, j) => (j === i ? next : r));
}

export function removeAt<T>(rows: readonly T[], i: number): T[] {
    return rows.filter((_, j) => j !== i);
}

/** Swap row `i` with its neighbour; out of range is no change (the same array back). */
export function moveAt<T>(rows: readonly T[], i: number, dir: -1 | 1): T[] {
    const j = i + dir;
    if (i < 0 || i >= rows.length || j < 0 || j >= rows.length) return rows as T[];
    const next = rows.slice();
    [next[i], next[j]] = [next[j] as T, next[i] as T];
    return next;
}

/** A list off the draft, or none. */
export function listOf<T = Record<string, unknown>>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

/** An object off the draft, or an empty one. */
export function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
