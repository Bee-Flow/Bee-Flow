/**
 * The small readers the per-family extractors and patchers share. Each one is
 * a JS idiom from agent-hub `Builder/flow/settings/formState.js` with a name,
 * so a step's twenty fields read as twenty calls rather than twenty ternaries.
 * Semantics are the idiom's, exactly — `or(v, d)` IS `v || d`.
 */

/** `v || fallback`. */
export function or(v: unknown, fallback: unknown): unknown {
    return v || fallback;
}

/** `typeof v === 'number' ? v : fallback`. */
export function num(v: unknown, fallback: unknown): unknown {
    return typeof v === 'number' ? v : fallback;
}

/** `typeof v === 'string' ? v : fallback`. */
export function strOr(v: unknown, fallback: unknown): unknown {
    return typeof v === 'string' ? v : fallback;
}

/** `Array.isArray(v) ? v : fallback`. */
export function arrOr(v: unknown, fallback: unknown): unknown {
    return Array.isArray(v) ? v : fallback;
}

/** `v && typeof v === 'object' ? v : fallback` (arrays included, as in the web). */
export function objOr(v: unknown, fallback: unknown): unknown {
    return v && typeof v === 'object' ? v : fallback;
}

/** A shallow copy of a plain object, or `{}`. */
export function plainCopy(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** `allowed.includes(v) ? v : fallback`. */
export function oneOf(v: unknown, allowed: readonly unknown[], fallback: unknown): unknown {
    return allowed.includes(v) ? v : fallback;
}

/** `Number.isFinite(Number(v)) ? Number(v) : fallback`. */
export function finiteOr(v: unknown, fallback: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** `v?.[key]` over anything. */
export function get(v: unknown, key: string): unknown {
    return v !== null && v !== undefined && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
}

/** `typeof v === 'string' && v.trim() ? v.trim() : fallback`. */
export function trimmedOr(v: unknown, fallback: unknown): unknown {
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/** `clamp(Math.round(Number(v) || d), lo, hi)` — the document steps' expiry rule. */
export function roundedClamp(v: unknown, d: number, lo: number, hi: number): number {
    return clamp(Math.round(Number(v) || d), lo, hi);
}

/**
 * Structural deep-equal for plain JSON values — key-order insensitive, so a
 * no-op baseline update never reads as dirty.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return arraysEqual(a, b as unknown[]);
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
}
