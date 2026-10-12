/**
 * A value from a list INSIDE a list, picked into a field that takes one
 * value (ValueBuilder's pick pipeline). The answer is one run per INNER item,
 * never every inner value joined into one run:
 *
 *   - the step already runs once per OUTER item (per order) and the value is
 *     a column of a list inside it (`loop.order.line_items[*].sku`, or the
 *     same column by its full path): the step moves down to the inner list
 *     and keeps the order bound (deepenForEach.ts);
 *   - the step does not run per item yet: it starts running once per inner
 *     item, with the outer items kept (`orders[*].line_items[*].sku` → per
 *     line item, `loop.order` still the order).
 *
 * Null for anything else; a one-level column stays mismatch.js's answer.
 *
 * Port of agent-hub `Builder/mapping/deepPick.ts` (the web's ValueBuilder pick
 * pipeline uses it); deepen.lockstep.test.ts holds the two together.
 */
import { getPath } from '@/shared/expr';

import {
    innerForEachPick, innerListPath, nestedListPick, newItemSample, relativeToItem,
} from './deepenForEach';
import type { DeepenPlan, ForEachConfig } from './deepenForEach';

export interface DeepenHandle {
    itemVar: string;
    /** The step's current forEach, when the editor hands it over (absolute paths need its list). */
    forEach?: ForEachConfig | null;
    overRef?: string;
    apply: (plan: DeepenPlan, newItem: Record<string, unknown> | null) => unknown;
}

export type DeepPick =
    | { binding: { kind: 'ref'; path: string }; itemVar: string; runs: number | null; plan: DeepenPlan; newItem: Record<string, unknown> | null; forEach?: undefined }
    | { binding: { kind: 'ref'; path: string }; itemVar: string; runs: number | null; plan?: undefined; forEach: ForEachConfig };

function deepenPick(path: string, handle: DeepenHandle, sampleRoot: unknown): DeepPick | null {
    const fe = handle.forEach || (handle.overRef ? { overRef: handle.overRef, itemVar: handle.itemVar } : null);
    const taken = (fe?.parents || []).map(p => p.itemVar);
    const plan = nestedListPick(relativeToItem(path, fe) || path, handle.itemVar, taken);
    if (!plan) return null;
    const list: unknown = sampleRoot ? getPath(sampleRoot, innerListPath(plan)) : undefined;
    return {
        binding: { kind: 'ref', path: `loop.${plan.itemVar}${plan.fieldTail}` },
        itemVar: plan.itemVar,
        runs: Array.isArray(list) ? list.length : null,
        plan,
        newItem: newItemSample(plan, sampleRoot),
    };
}

export function planDeepPick(
    path: string,
    { deepenForEach = null, canForEach = false, sampleRoot = null }: { deepenForEach?: DeepenHandle | null; canForEach?: boolean; sampleRoot?: unknown },
): DeepPick | null {
    if (deepenForEach?.apply) return deepenPick(path, deepenForEach, sampleRoot);
    if (!canForEach) return null;
    const inner = innerForEachPick(path, sampleRoot);
    return inner ? { binding: inner.binding, itemVar: inner.itemVar, runs: inner.runs, forEach: inner.forEach } : null;
}
