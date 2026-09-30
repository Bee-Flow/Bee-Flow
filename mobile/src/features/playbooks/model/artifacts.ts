/**
 * Reading a phase's artifacts, which stay an open record on the wire: every
 * phase kind writes its own keys (tablePhase, fillPhase, designPhase,
 * compliancePhase and the client's PATCHes), so the stages read them through
 * these total accessors instead of trusting a shape.
 */

import type { Artifacts } from './types';

/** A non-empty string, else null. */
export function artStr(a: Artifacts | null | undefined, key: string): string | null {
    const v = a?.[key];
    return typeof v === 'string' && v ? v : null;
}

/** A finite number, else null (the web's Number.isFinite checks). */
export function artNum(a: Artifacts | null | undefined, key: string): number | null {
    const v = a?.[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** An array, else null — "no list" and "an empty list" stay different answers. */
export function artList(a: Artifacts | null | undefined, key: string): unknown[] | null {
    const v = a?.[key];
    return Array.isArray(v) ? v : null;
}

/** A plain object, else null. */
export function artRecord(a: Artifacts | null | undefined, key: string): Record<string, unknown> | null {
    const v = a?.[key];
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The objects in an array field, anything else dropped. */
export function artRecords(a: Artifacts | null | undefined, key: string): Record<string, unknown>[] {
    return (artList(a, key) ?? []).filter(
        (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x),
    );
}

/** A string property of a loose object, else ''. */
export function textOf(o: Record<string, unknown> | null | undefined, key: string): string {
    const v = o?.[key];
    return typeof v === 'string' ? v : '';
}
