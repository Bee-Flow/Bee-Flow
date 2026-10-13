/**
 * The small value helpers buildPatch and its per-type writers share: drop
 * blank keys, clamp a number, and compare two JSON values structurally.
 */
import type { FormRecord, JsonValue } from './types';

export function stripUndefined(obj: FormRecord | null | undefined): FormRecord {
    const out: FormRecord = {};
    for (const [k, v] of Object.entries(obj || {})) {
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

export function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

/**
 * Structural deep-equal for plain JSON values. Replaces JSON.stringify
 * comparisons whose key-order instability could either claim dirty=false
 * for real changes (Save button greys out) or dirty=true after a no-op
 * baseline update (autosave loop).
 */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
}
