/**
 * What colour a connection is drawn in — the web builder's flow/edgeColors.js
 * and the "branches" half of flow/edgeColoring.js (the canvas's default
 * "Colour lines by" mode), pinned by edgeColors.lockstep.test.ts.
 *
 * A connection's persisted `color` is a palette key, never a hex, and it
 * always wins; otherwise a switch's case lines take the case's slot in the
 * chart series, so the line and its port agree. Everything else draws in the
 * neutral line colour. A test run then paints what it did over that: the
 * line into a failed step red, a line the run travelled green (or thicker in
 * its own colour).
 */

import type { EdgeColorKey } from '@/features/flow-editor/model';

/** agent-hub/src/constants/palette.js STATUS_COLORS: the eight swatches. */
export const EDGE_COLOR_HEX: Readonly<Record<EdgeColorKey, string>> = Object.freeze({
    blue: '#3b82f6',
    green: '#10b981',
    amber: '#f59e0b',
    orange: '#f97316',
    rose: '#f43f5e',
    red: '#ef4444',
    cyan: '#06b6d4',
    slate: '#64748b',
});

/** palette.js CHART_SERIES: the order automatic case colours are dealt in. */
export const CASE_SERIES: readonly string[] = Object.freeze([
    EDGE_COLOR_HEX.blue,
    EDGE_COLOR_HEX.green,
    EDGE_COLOR_HEX.amber,
    EDGE_COLOR_HEX.rose,
    EDGE_COLOR_HEX.cyan,
    EDGE_COLOR_HEX.orange,
    EDGE_COLOR_HEX.slate,
]);

/** Palette key → hex; anything else (a typo, null) → null. */
export function resolveEdgeColor(key: unknown): string | null {
    if (typeof key !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(EDGE_COLOR_HEX, key) ? EDGE_COLOR_HEX[key as EdgeColorKey] : null;
}

/** A case's colour by its index in the switch's `cases`; wraps, and takes negatives. */
export function autoCaseColor(caseIndex: unknown): string {
    const n = CASE_SERIES.length;
    const i = Number.isInteger(caseIndex) ? (caseIndex as number) : 0;
    return CASE_SERIES[((i % n) + n) % n] as string;
}

/** The line's own colour: the picked one, else its case's; null is the neutral line. */
export function identityColor(edge: { color?: unknown; caseIndex?: number | null }): string | null {
    const manual = resolveEdgeColor(edge.color);
    if (manual) return manual;
    return edge.caseIndex != null ? autoCaseColor(edge.caseIndex) : null;
}

export interface RunRowLike {
    status?: string | null;
}

export interface EdgeInk {
    /** Null: the theme's neutral line colour. */
    color: string | null;
    width: number;
}

const done = (row: RunRowLike | null | undefined) => row?.status === 'success' || row?.status === 'pinned';

/**
 * The stroke after the last test run (edgeColoring.js decorateRunEdges,
 * without the in-flight animation — the phone shows a finished run): a
 * failure beats even a picked colour, because it must be findable.
 */
export function edgeInk(identity: string | null, source: RunRowLike | null | undefined, target: RunRowLike | null | undefined): EdgeInk {
    if (target?.status === 'error') return { color: EDGE_COLOR_HEX.red, width: 1.5 };
    if (done(source) && done(target)) return identity ? { color: identity, width: 2.5 } : { color: EDGE_COLOR_HEX.green, width: 1.5 };
    return { color: identity, width: identity ? 2 : 1.5 };
}
