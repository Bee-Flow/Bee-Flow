/**
 * Narrowing helpers for the JSON the server hands over. The web modules this
 * folder ports read `x && typeof x === 'object'` inline; TypeScript needs the
 * answer as a type guard, and one spelling keeps the ports readable.
 */

import type { Obj } from './types';

/** A plain object — not null, not an array. */
export function isObj(v: unknown): v is Obj {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Any object, arrays included (JS `typeof v === 'object'` minus null). */
export function isObjectLike(v: unknown): v is Obj | unknown[] {
    return v !== null && typeof v === 'object';
}

/** `Array.isArray(v) ? v : []`. */
export function arr<T = unknown>(v: unknown): T[] {
    return Array.isArray(v) ? (v as T[]) : [];
}

/** `v && typeof v === 'object' && !Array.isArray(v) ? v : {}`. */
export function obj(v: unknown): Obj {
    return isObj(v) ? v : {};
}

/** Read one key off anything, like `v?.[key]` in JS. */
export function prop(v: unknown, key: string): unknown {
    return isObjectLike(v) ? (v as Obj)[key] : undefined;
}
