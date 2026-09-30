/**
 * The column a list-mode Date & time step writes into, and the "a whole column
 * went into Input date" switch to list mode (BFSF-375). Port of agent-hub
 * `Builder/flow/datetimeTarget.js`, which mirrors `datetimeTargetColumn` in
 * server/core/automationRunner/engine.js. Pinned by flowDeps.lockstep.test.ts.
 */

import type { FlowNode } from '../types';

export function datetimeTargetColumn(step: Partial<FlowNode> | null | undefined): string {
    if (typeof step?.target === 'string' && step.target.trim()) return step.target.trim();
    if (step?.op === 'extract' && step.part) return String(step.part);
    if (step?.op === 'diff') return 'diff';
    if (step?.op === 'format') return 'formatted';
    return String(step?.op || 'value');
}

/** True when this step works through a list rather than a single date. */
export function isDateTimeListMode(step: Partial<FlowNode> | null | undefined): boolean {
    return typeof step?.arrayRef === 'string';
}

/**
 * `steps.x.output.results[*].updated` → `{ arrayRef, itemPath: 'item.updated' }`;
 * null without a `[*]`, or with a second one (a list of lists).
 */
export function splitWildcardPath(path: unknown): { arrayRef: string; itemPath: string } | null {
    const s = String(path || '');
    const at = s.indexOf('[*]');
    if (at < 0) return null;
    const arrayRef = s.slice(0, at);
    const tail = s.slice(at + 3).replace(/^\./, '');
    if (!arrayRef) return null;
    if (tail.includes('[*]')) return null;
    return { arrayRef, itemPath: tail ? `item.${tail}` : 'item' };
}

/** What changes when the author puts something in "Input date". */
export function dateInputPatch(
    value: unknown,
    { listMode = false }: { listMode?: boolean } = {},
): { input: unknown } | { arrayRef: string; input: string } {
    const split = listMode ? null : splitWildcardPath(value);
    if (!split) return { input: value };
    return { arrayRef: split.arrayRef, input: split.itemPath };
}
